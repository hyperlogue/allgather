import { PUBLICATION_LIMITS, UPLOAD_LIMITS } from "../shared/artifact-limits.ts";
import {
  ArtifactError,
  canonicalJson,
  jsonObject,
  optionalText,
  requireActor,
  requireArtifactPath,
  requireMediaType,
  requireObject,
  requireSequence,
  requireString,
} from "../shared/artifact-validation.ts";
import type { ArtifactActor, ArtifactKind } from "../shared/artifacts.ts";
import { type BlobStore, hashBytes, type StoredBlob } from "./blobs.ts";
import { validateStoredPatch } from "./patch-content.ts";

interface DecodedFile extends StoredBlob {
  path: string;
  mediaType: string;
  bytes: Buffer | null;
}

export type PartAssembler = (parts: string[]) => Promise<StoredBlob>;

export interface ValidatedPublication {
  expectedSeq: number;
  publicationKey: string;
  actor: ArtifactActor;
  label: string | null;
  summary: string | null;
  provenance: Record<string, unknown>;
  kind: ArtifactKind;
  contentHash: string;
  entrypoint: "index.html" | null;
  patch: string | null;
  files: DecodedFile[];
}

export interface PreparedFile extends StoredBlob {
  path: string;
  mediaType: string;
  rendered: (StoredBlob & { revision: string }) | null;
}

export type DocumentRenderer = {
  (source: string, path: string): Promise<{ html: string; revision: string }>;
  // Declaring a revision promises deterministic output for source + path.
  // Unversioned adapters still render normally, without reusable results.
  readonly revision?: string;
};

function decodeMarkdown(bytes: Buffer): string {
  if (bytes.byteLength > PUBLICATION_LIMITS.markdownBytes) {
    throw new ArtifactError("Markdown exceeds the rendering size limit", 413);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ArtifactError("Markdown must contain valid UTF-8");
  }
}

function requireParts(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > UPLOAD_LIMITS.parts ||
    value.some((part) => typeof part !== "string" || !/^[0-9a-f]{64}$/.test(part))
  )
    throw new ArtifactError(
      `File parts must list 1 to ${UPLOAD_LIMITS.parts} uploaded SHA-256 hashes`,
    );
  return value;
}

async function decodeFile(value: unknown, assemble?: PartAssembler): Promise<DecodedFile> {
  const file = requireObject(value, "File");
  const path = requireArtifactPath(file.path);
  const mediaType = requireMediaType(file.mediaType);
  if (file.parts !== undefined) {
    if (file.base64 !== undefined)
      throw new ArtifactError("A file takes base64 or parts, not both");
    const parts = requireParts(file.parts);
    if (!assemble) throw new ArtifactError("Uploaded parts are not available here");
    const blob = await assemble(parts);
    if (blob.byteLength > PUBLICATION_LIMITS.fileBytes)
      throw new ArtifactError("File exceeds the publication size limit", 413);
    return { path, mediaType, ...blob, bytes: null };
  }
  if (typeof file.base64 !== "string")
    throw new ArtifactError("File bytes must be base64 text or uploaded parts");
  if (file.base64.length > Math.ceil(PUBLICATION_LIMITS.fileBytes / 3) * 4) {
    throw new ArtifactError("File exceeds the publication size limit", 413);
  }
  // Buffer's decoder is deliberately forgiving. The wire contract is not:
  // reject truncation, skipped garbage and noncanonical padding bits.
  const bytes = Buffer.from(file.base64, "base64");
  if (bytes.toString("base64") !== file.base64)
    throw new ArtifactError("Invalid base64 file bytes");
  if (bytes.byteLength > PUBLICATION_LIMITS.fileBytes) {
    throw new ArtifactError("File exceeds the publication size limit", 413);
  }
  return { path, mediaType, hash: hashBytes(bytes), byteLength: bytes.byteLength, bytes };
}

export async function validatePublication(
  value: unknown,
  directoryLimits: { files: number; totalBytes: number } = PUBLICATION_LIMITS,
  assemble?: PartAssembler,
): Promise<ValidatedPublication> {
  const body = requireObject(value, "Publication");
  const content = requireObject(body.content, "Publication content");
  const metadata = {
    expectedSeq: requireSequence(body.expectedSeq, true),
    publicationKey: requireString(body.publicationKey, "publicationKey", 200),
    actor: requireActor(body.actor),
    label: optionalText(body.label, "label", 1000),
    summary: optionalText(body.summary, "summary"),
    provenance: jsonObject(body.provenance === undefined ? {} : body.provenance, "provenance"),
  };
  if (content.kind === "diff") {
    const patch = requireString(content.patch, "Patch", PUBLICATION_LIMITS.patchBytes);
    if (Buffer.byteLength(patch) > PUBLICATION_LIMITS.patchBytes) {
      throw new ArtifactError("Patch exceeds the publication size limit", 413);
    }
    validateStoredPatch(patch);
    return {
      ...metadata,
      kind: "diff",
      patch,
      entrypoint: null,
      files: [],
      contentHash: hashBytes(canonicalJson({ kind: "diff", patch })),
    };
  }
  if (content.kind !== "files" && content.kind !== "html") {
    throw new ArtifactError("Publication kind must be files, html, or diff");
  }
  if (!Array.isArray(content.files) || !content.files.length) {
    throw new ArtifactError("A directory publication must contain at least one file");
  }
  if (content.files.length > directoryLimits.files) {
    throw new ArtifactError("Publication contains too many files", 413);
  }
  let total = 0;
  const files: DecodedFile[] = [];
  for (const input of content.files) {
    const file = await decodeFile(input, assemble);
    total += file.byteLength;
    if (total > directoryLimits.totalBytes) {
      throw new ArtifactError("Publication exceeds the total size limit", 413);
    }
    if (/\.(md|markdown)$/i.test(file.path)) {
      if (file.byteLength > PUBLICATION_LIMITS.markdownBytes)
        throw new ArtifactError("Markdown exceeds the rendering size limit", 413);
      if (file.bytes) decodeMarkdown(file.bytes);
    }
    files.push(file);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw new ArtifactError("Duplicate file path in publication");
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(parts.slice(0, i).join("/"))) {
        throw new ArtifactError("A publication path cannot be both a file and a directory");
      }
    }
    paths.add(file.path);
  }
  let entrypoint: "index.html" | null = null;
  if (content.kind === "files") {
    if (content.entrypoint !== undefined)
      throw new ArtifactError("Files artifacts have no entrypoint");
  } else {
    if (!paths.has("index.html"))
      throw new ArtifactError(
        "HTML requires a root index.html; publish Markdown as a files artifact",
      );
    if (content.entrypoint !== undefined)
      throw new ArtifactError("HTML entrypoint is selected automatically; omit entrypoint");
    entrypoint = "index.html";
    const index = files.find((file) => file.path === entrypoint)!;
    if (index.mediaType.split(";")[0] !== "text/html") {
      throw new ArtifactError("index.html must have the text/html media type");
    }
  }
  return {
    ...metadata,
    kind: content.kind,
    entrypoint,
    patch: null,
    files,
    contentHash: hashBytes(
      canonicalJson({
        kind: content.kind,
        entrypoint,
        files: files.map((file) => ({
          path: file.path,
          mediaType: file.mediaType,
          hash: file.hash,
        })),
      }),
    ),
  };
}

// Async work completes before entering SQLite's publication transaction. The
// renderer is injected so retained output can be tested across renderer upgrades.
export async function prepareFiles(
  publication: ValidatedPublication,
  blobs: BlobStore,
  renderDocument: DocumentRenderer,
  retained?: (hash: string, path: string, revision: string) => StoredBlob | null,
): Promise<PreparedFile[]> {
  const prepared: PreparedFile[] = [];
  for (const file of publication.files) {
    const stored: StoredBlob = file.bytes
      ? await blobs.put(file.bytes)
      : { hash: file.hash, byteLength: file.byteLength };
    let rendered: PreparedFile["rendered"] = null;
    if (/\.(md|markdown)$/i.test(file.path)) {
      const source = decodeMarkdown(file.bytes ?? (await blobs.read(file.hash)));
      const declared = renderDocument.revision;
      const cached = declared ? retained?.(stored.hash, file.path, declared) : null;
      if (cached && declared) {
        // Publication holds the blob collector. Verify retained bytes before
        // making another immutable version depend on them.
        await blobs.read(cached.hash);
        rendered = { ...cached, revision: declared };
      } else {
        const document = await renderDocument(source, file.path);
        const revision = requireString(document.revision, "Renderer revision", 200);
        if (declared !== undefined && declared !== revision)
          throw new Error("Document renderer returned a different revision");
        rendered = { ...(await blobs.put(document.html)), revision };
      }
    }
    prepared.push({ path: file.path, mediaType: file.mediaType, ...stored, rendered });
  }
  return prepared;
}
