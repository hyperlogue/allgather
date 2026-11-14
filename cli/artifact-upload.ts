import { UPLOAD_LIMITS } from "../shared/artifact-limits.ts";
import type { PublicationFile } from "../shared/artifacts.ts";

export const INLINE_PUBLICATION_BYTES = 32 * 1024 * 1024;

export async function stageLargeFiles(
  content: unknown,
  upload: (data: string) => Promise<string>,
  inlineBytes = INLINE_PUBLICATION_BYTES,
): Promise<unknown> {
  const record = content as { files?: PublicationFile[] } | null;
  if (!record || !Array.isArray(record.files)) return content;
  const files = record.files;
  let inline = files.reduce((sum, file) => sum + ("base64" in file ? file.base64.length : 0), 0);
  const staged = new Map<number, PublicationFile>();
  const bySize = files
    .map((file, index) => ({ file, index }))
    .filter((entry) => "base64" in entry.file)
    .sort(
      (a, b) =>
        (b.file as { base64: string }).base64.length - (a.file as { base64: string }).base64.length,
    );
  for (const { file, index } of bySize) {
    const base64 = (file as { base64: string }).base64;
    const bytes = Buffer.from(base64, "base64");
    if (inline <= inlineBytes && bytes.byteLength <= UPLOAD_LIMITS.partBytes) break;
    const parts: string[] = [];
    for (let at = 0; at < bytes.byteLength; at += UPLOAD_LIMITS.partBytes)
      parts.push(await upload(bytes.subarray(at, at + UPLOAD_LIMITS.partBytes).toString("base64")));
    staged.set(index, { path: file.path, mediaType: file.mediaType, parts });
    inline -= base64.length;
  }
  if (!staged.size) return content;
  return { ...record, files: files.map((file, index) => staged.get(index) ?? file) };
}
