import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validatePublication } from "../server/publication.ts";
import { buildArtifactPrompt } from "../shared/artifact-prompt.ts";
import type {
  ArtifactCommentAcknowledgment,
  ArtifactDetail,
  ArtifactThread,
} from "../shared/artifacts.ts";
import type { ArtifactAttachment } from "../shared/attachments.ts";
import { type Operation, operations } from "../shared/contracts.ts";
import { artifactGuide } from "./artifact-guide.ts";
import { downloadCommentImages, readAttachmentFiles } from "./artifact-images.ts";
import {
  artifactTarget,
  type ArtifactFlags as Flags,
  metadata,
  validateArtifactOptions,
} from "./artifact-options.ts";
import { watchArtifact, watchOperator } from "./artifact-watch.ts";
import { captureFiles } from "./capture.ts";
import { captureGitCommit, captureGitDiff, captureGitFiles } from "./capture-git.ts";
import type { Client } from "./client.ts";
import { detectPublisherRemote } from "./publisher-remote.ts";

const readText = (path: string) =>
  new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path === "-" ? 0 : path));
const writeOutput = (bytes: string | Uint8Array) =>
  new Promise<void>((resolve, reject) =>
    process.stdout.write(bytes, (error) => (error ? reject(error) : resolve())),
  );
export async function artifactCommand(client: Client, p: string[], f: Flags) {
  const verb = p[1],
    id = p[2],
    text = (key: string) => (typeof f[key] === "string" ? (f[key] as string) : undefined);
  validateArtifactOptions(verb, p, f);
  if (verb === "guide") {
    console.log(f.json ? JSON.stringify({ guide: artifactGuide(id) }) : artifactGuide(id));
    return;
  }
  const print = (v: unknown) => console.log(JSON.stringify(v, null, f.json ? undefined : 2));
  const key = text("key") ?? randomUUID(),
    phaseKey = (phase: string) =>
      createHash("sha256")
        .update(JSON.stringify([key, phase]))
        .digest("hex"),
    call = (op: Operation, input: Record<string, unknown> = {}) =>
      client.call(
        op,
        Object.fromEntries(
          Object.entries({ operation_key: key, ...input }).filter(
            ([k]) => k in operations[op].schema.shape,
          ),
        ),
      );
  const get = async (path: string) => (await client.request(path)).json();
  const requireId = () => {
    if (!id) throw new Error("Supply an artifact or thread ID");
    return encodeURIComponent(id);
  };
  const base = () => `/api/artifacts/${requireId()}`;
  const inputFile = () => (f.input ? JSON.parse(readText(String(f.input))) : {});
  const body = () => (f["body-file"] ? readText(String(f["body-file"])) : text("body"));
  const detail = () => client.call<ArtifactDetail>("artifacts_get", { artifact_id: id });
  const version = async () =>
    f.version ? Number(f.version) : ((await detail()).versions.at(-1)?.seq ?? 0);
  const capture = async (kind: string) => {
    const root = resolve(text("root") ?? ".");
    if (f.input) {
      if (
        ["root", "path", "ref", "patch", "commit", "base", "head"].some((k) => f[k] !== undefined)
      )
        throw new Error("Use --input or capture flags, not both");
      const content = inputFile();
      if (content.kind !== kind) throw new Error("Input kind must match artifact kind");
      return content;
    }
    const selectors = ["patch", "commit", "base"].filter((k) => f[k] !== undefined);
    if (selectors.length > 1) throw new Error("Choose one diff capture mode");
    if (f.head && !f.base) throw new Error("--head requires --base");
    if (kind === "diff") {
      if (f.ref || f.path) throw new Error("Diff captures do not accept --ref or --path");
      const patch = f.patch
        ? readText(String(f.patch))
        : f.commit
          ? await captureGitCommit(root, String(f.commit))
          : f.base
            ? await captureGitDiff(root, String(f.base), text("head") ?? "WORKING")
            : null;
      if (patch === null)
        throw new Error("Diff publication needs --patch FILE, --commit SHA, or --base REF");
      return { kind, patch };
    }
    if (selectors.length || f.head) throw new Error("Diff capture flags require kind diff");
    const paths = (f.path as string[] | undefined) ?? ["."];
    return {
      kind,
      files: f.ref
        ? await captureGitFiles(root, String(f.ref), paths)
        : await captureFiles(root, paths),
    };
  };
  const publish = async (
    artifactId: string,
    content: unknown,
    expected: number,
    publicationKey: string,
  ) => {
    try {
      const result = await call("artifacts_publish", {
        operation_key: publicationKey,
        artifact_id: artifactId,
        expected_seq: expected,
        content,
        label: text("version-label") ?? text("label"),
        summary: text("summary"),
        task_id: text("task"),
        listen: !f["no-listen"],
      });
      return {
        ...(result as Record<string, unknown>),
        url: `${client.url}/?view=artifacts&artifact=${encodeURIComponent(artifactId)}`,
      };
    } catch (error) {
      console.error(
        `Publication not confirmed: ${JSON.stringify({ artifact_id: artifactId, key: publicationKey, expected_seq: expected })}. Retry publish with unchanged capture and metadata, --key and --expected-seq shown above.`,
      );
      throw error;
    }
  };
  if (verb === "create") {
    const kind = text("kind") ?? "files";
    const hasCapture = ["root", "path", "ref", "patch", "commit", "base", "input"].some(
      (k) => f[k] !== undefined,
    );
    if (
      !hasCapture &&
      ["summary", "label", "version-label", "head", "expected-seq", "no-listen"].some(
        (k) => f[k] !== undefined,
      )
    )
      throw new Error("Publication flags require capture flags");
    if (f["expected-seq"] !== undefined && Number(f["expected-seq"]) !== 0)
      throw new Error("Initial publication requires --expected-seq 0");
    const content = hasCapture ? await capture(kind) : undefined;
    if (hasCapture)
      validatePublication({
        content,
        expectedSeq: 0,
        publicationKey: phaseKey("publish"),
        actor: { role: "human", sessionId: null },
        label: text("version-label") ?? text("label"),
        summary: text("summary"),
      });
    const remote = f.remote
      ? text("remote")
      : (await detectPublisherRemote(process.cwd())).remote?.url;
    let artifact: { id: string };
    try {
      artifact = (await call("artifacts_create", {
        kind,
        title: text("title"),
        project_id: text("project"),
        task_id: text("task"),
        remote_url: remote,
        meta: {
          ...(client.operator.operator_kind === "agent" && client.operator.session_id
            ? { session: client.operator.session_id }
            : {}),
          ...metadata(f),
        },
      })) as { id: string };
    } catch (error) {
      console.error(
        `Creation not confirmed. Retry unchanged create with --key ${JSON.stringify(key)}.`,
      );
      throw error;
    }
    if (!hasCapture) print(artifact);
    else
      print({
        ...artifact,
        publication: await publish(artifact.id, content, 0, phaseKey("publish")),
        url: `${client.url}/?view=artifacts&artifact=${encodeURIComponent(artifact.id)}`,
      });
    return;
  }
  if (verb === "publish") {
    const d = await detail();
    print(
      await publish(
        id,
        await capture(d.kind),
        f["expected-seq"] === undefined ? (d.versions.at(-1)?.seq ?? 0) : Number(f["expected-seq"]),
        key,
      ),
    );
    return;
  }
  if (verb === "list" || verb === "search") {
    const meta = metadata(f);
    if (f.mine) {
      if (!client.operator.session_id) throw new Error("--mine requires an agent session");
      meta.session = client.operator.session_id;
    }
    print(
      await client.call(verb === "list" ? "artifacts_list" : "artifacts_search", {
        project_id: text("project"),
        state: text("state"),
        kind: text("kind"),
        cursor: f.cursor ? Number(f.cursor) : 0,
        limit: f.limit ? Number(f.limit) : 50,
        ...(verb === "list"
          ? { meta }
          : {
              query: id,
              history: text("history") ?? (f.all ? "all" : "latest"),
              attention: !!f.attention,
              type: text("type") ?? "all",
            }),
      }),
    );
    return;
  }
  if (verb === "versions") {
    print((await detail()).versions);
    return;
  }
  if (verb === "thread-delete") {
    print(await call("artifact_threads_delete", { thread_id: id }));
    return;
  }
  if (verb === "show") {
    print(await detail());
    return;
  }
  if (verb === "files") {
    print(await client.call("artifacts_files", { artifact_id: id, version_seq: await version() }));
    return;
  }
  if (verb === "source") {
    print(
      await client.call("artifacts_read_file", {
        artifact_id: id,
        version_seq: await version(),
        path: (f.path as string[])?.[0],
        start_line: f.start ? Number(f.start) : 1,
        limit: f.limit ? Number(f.limit) : 200,
      }),
    );
    return;
  }
  if (["download", "patch", "image"].includes(verb)) {
    const path =
      verb === "image"
        ? `${base()}/attachments/${encodeURIComponent(String(f.image))}`
        : `${base()}/versions/${await version()}/${verb === "patch" ? "patch" : `resource?path=${encodeURIComponent((f.path as string[])?.[0] ?? "")}`}`;
    const bytes = new Uint8Array(await (await client.request(path)).arrayBuffer());
    if (f.output) {
      writeFileSync(String(f.output), bytes, { flag: "wx", mode: 0o600 });
      print({ saved: true, bytes: bytes.length });
    } else await writeOutput(bytes);
    return;
  }
  const fetchComments = async () =>
    (await get(
      `${base()}/comments/${f.all ? "history" : "pending"}${f.threads ? `?threads=${encodeURIComponent(String(f.threads))}` : ""}`,
    )) as {
      text: string;
      acknowledgment?: ArtifactCommentAcknowledgment;
      attachments: ArtifactAttachment[];
      itemCount: number;
    };
  const deliverComments = async (
    result: Awaited<ReturnType<typeof fetchComments>>,
    subscribe: boolean,
  ) => {
    const files: Record<string, string> = {};
    if (f["attachments-dir"]) {
      const saved = await downloadCommentImages(
        client,
        result.attachments,
        resolve(String(f["attachments-dir"])),
      );
      result.attachments.forEach((attachment, index) => {
        files[attachment.id] = saved[index];
      });
    }
    const output = f.json
      ? JSON.stringify({ ...result, files })
      : result.text +
        (Object.keys(files).length ? `\nSaved attachments: ${JSON.stringify(files)}\n` : "");
    await writeOutput(`${output}\n`);
    if (verb === "watch" && (await detail()).state === "archived") return false;
    if (result.acknowledgment && !f.all && !f["no-ack"]) {
      await call("artifact_comments_ack", {
        artifact_id: id,
        receipt: result.acknowledgment,
        ...(verb === "watch" ? watchOperator(client) : {}),
      });
      if (subscribe && client.operator.operator_kind === "agent") {
        try {
          await call("artifacts_listen", {
            artifact_id: id,
            mode: "explicit",
            operation_key: phaseKey("listen"),
          });
        } catch (error) {
          console.error(
            `Comments delivered, but subscription failed: ${(error as Error).message}. Use artifact listen or watch.`,
          );
        }
      }
    }
    return true;
  };
  if (verb === "comments") {
    await deliverComments(await fetchComments(), true);
    return;
  }
  if (verb === "watch") {
    const result = await watchArtifact(client, id, f.timeout === undefined ? 0 : Number(f.timeout));
    if (result.result === "archived") {
      if (result.event?.comment?.body) await writeOutput(`${result.event.comment.body}\n`);
      process.exitCode = 0;
    } else if (result.result === "timeout") process.exitCode = 2;
    else if (result.result === "superseded" || result.result === "cancelled") process.exitCode = 4;
    else if (result.result === "deleted") throw new Error("Artifact was deleted while watching");
    else {
      try {
        process.exitCode = (await deliverComments(await fetchComments(), false)) ? 10 : 0;
      } catch (error) {
        if ((error as { status?: number }).status !== 409) throw error;
        process.exitCode = (await detail()).state === "archived" ? 0 : 4;
      }
    }
    return;
  }
  if (verb === "prompt") {
    const d = await detail();
    console.log(
      buildArtifactPrompt(
        d,
        d.threads,
        false,
        d.events.flatMap((e) => (e.comment ? [e.comment] : [])),
      ),
    );
    return;
  }
  if (verb === "thread-source") {
    print(await get(`/api/threads/${requireId()}/source`));
    return;
  }
  if (verb === "comment-show") {
    print(await client.call("artifact_comments_get", { comment_id: id }));
    return;
  }
  if (
    verb === "thread-add" ||
    verb === "comment" ||
    verb === "thread-edit" ||
    verb === "comment-edit"
  ) {
    const target = artifactTarget(f);
    const message = body();
    const input: Record<string, unknown> = {
      ...inputFile(),
      ...(message === undefined ? {} : { body: message }),
      ...(target ? { target } : {}),
      ...(f.attach
        ? { attachments: await readAttachmentFiles(f.attach as string[], process.cwd()) }
        : f["clear-attachments"]
          ? { attachments: [] }
          : {}),
      ...(f.frame
        ? { mediaSnapshot: (await readAttachmentFiles([String(f.frame)], process.cwd()))[0] }
        : {}),
      ...(f.status ? { status: f.status } : {}),
    };
    if (verb === "thread-add" && !("target" in input))
      Object.assign(input, { target: { kind: "artifact" } });
    if (verb === "comment") {
      const target = input.target as Record<string, unknown> | undefined;
      if (target && "path" in target && !input.reanchor) {
        const thread = (await get(`/api/threads/${requireId()}`)) as ArtifactThread;
        const latest =
          f["expected-seq"] === undefined
            ? (
                await client.call<ArtifactDetail>("artifacts_get", {
                  artifact_id: thread.artifactId,
                })
              ).versions.at(-1)?.seq
            : Number(f["expected-seq"]);
        if (f["expected-seq"] !== undefined || target.versionSeq === latest) {
          if (!("anchor" in thread))
            throw new Error("Backend does not support guarded reanchoring");
          input.reanchor = {
            expectedSeq: latest,
            expectedAnchorRevision:
              f["expected-anchor"] === undefined
                ? (thread.anchor?.revision ?? 0)
                : Number(f["expected-anchor"]),
          };
        } else if (f["expected-anchor"] !== undefined)
          throw new Error("Historical targets do not reanchor");
      } else if (
        (!target || !("path" in target)) &&
        (f["expected-seq"] !== undefined || f["expected-anchor"] !== undefined)
      )
        throw new Error("Revision guards require a document target");
    }
    try {
      print(
        await call(
          verb === "thread-add"
            ? "artifact_threads_add"
            : verb === "comment"
              ? "artifact_comments_add"
              : verb === "thread-edit"
                ? "artifact_threads_edit"
                : "artifact_comments_edit",
          { artifact_id: id, thread_id: id, comment_id: id, input },
        ),
      );
    } catch (error) {
      console.error(
        `Message not confirmed. Retry unchanged input: ${JSON.stringify({ key, ...((input.reanchor as object) ?? {}) })}. Preserve --expected-seq and --expected-anchor when present.`,
      );
      throw error;
    }
    return;
  }
  if (verb === "claim" || verb === "release") {
    print(
      await call(verb === "claim" ? "artifact_threads_claim" : "artifact_threads_release", {
        thread_ids: p.slice(2),
      }),
    );
    return;
  }
  if (verb === "reanchor") {
    let artifactId: string;
    let input: Record<string, unknown>;
    if (f.input) {
      if (
        [
          "target",
          "file",
          "view",
          "line",
          "quote",
          "selector",
          "route",
          "side",
          "frame",
          "expected-anchor",
        ].some((k) => f[k] !== undefined)
      )
        throw new Error("Bulk targets and revisions belong in --input");
      artifactId = text("artifact") ?? id;
      const raw = inputFile();
      if (Array.isArray(raw)) {
        if (!f.version) throw new Error("Bulk arrays require --version");
        input = { expectedSeq: Number(f.version), items: raw };
      } else {
        if (f.version) throw new Error("Object input already contains expectedSeq; omit --version");
        input = raw;
      }
    } else {
      if (f.artifact) throw new Error("--artifact requires bulk --input");
      const target = artifactTarget(f, true);
      if (!target || !("versionSeq" in target)) throw new Error("Supply a reanchor destination");
      const thread = (await get(`/api/threads/${requireId()}`)) as ArtifactThread;
      if (!("anchor" in thread)) throw new Error("Backend does not support guarded reanchoring");
      artifactId = thread.artifactId;
      input = {
        expectedSeq: target.versionSeq,
        items: [
          {
            threadId: id,
            target,
            expectedAnchorRevision:
              f["expected-anchor"] === undefined
                ? (thread.anchor?.revision ?? 0)
                : Number(f["expected-anchor"]),
            ...(f.frame
              ? { mediaSnapshot: (await readAttachmentFiles([String(f.frame)], process.cwd()))[0] }
              : {}),
          },
        ],
      };
    }
    if (!artifactId) throw new Error("Supply an artifact ID for bulk reanchoring");
    try {
      print(await call("artifact_threads_reanchor", { artifact_id: artifactId, input }));
    } catch (error) {
      console.error(
        `Reanchor not confirmed. Retry unchanged input: ${JSON.stringify({ key, expectedSeq: input.expectedSeq, revisions: (input.items as { threadId: string; expectedAnchorRevision: number }[])?.map(({ threadId, expectedAnchorRevision }) => ({ threadId, expectedAnchorRevision })) })}`,
      );
      throw error;
    }
    return;
  }
  if (verb === "edit") {
    print(
      await call("artifacts_edit", {
        artifact_id: id,
        input: {
          ...inputFile(),
          ...(f.title ? { title: f.title } : {}),
          ...(f.meta ? { meta: metadata(f) } : {}),
        },
      }),
    );
    return;
  }
  if (["archive", "restore", "delete", "listen", "unlisten", "submit", "watchers"].includes(verb)) {
    print(
      await call(`artifacts_${verb}` as Operation, {
        artifact_id: id,
        comment: body(),
        mode: text("mode") ?? "explicit",
      }),
    );
    return;
  }
  if (verb === "stat") {
    print(await client.call("artifacts_usage", { window: text("window") ?? "daily" }));
    return;
  }
  if (verb === "gc") {
    print(await call("artifacts_gc", { input: { ...inputFile(), dryRun: !f.apply } }));
    return;
  }
  throw new Error("Unknown artifact command. Run allgather help.");
}
