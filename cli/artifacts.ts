import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hashBytes } from "../server/blobs.ts";
import { captureFiles } from "../server/r3/cli/capture.ts";
import { captureGitCommit, captureGitDiff, captureGitFiles } from "../server/r3/cli/capture-git.ts";
import { detectPublisherRemote } from "../server/r3/cli/publisher-remote.ts";
import { buildArtifactPrompt } from "../server/r3/shared/artifact-prompt.ts";
import type {
  ArtifactCommentAcknowledgment,
  ArtifactDetail,
} from "../server/r3/shared/artifacts.ts";
import type { ArtifactAttachment } from "../server/r3/shared/attachments.ts";
import { type Operation, operations } from "../shared/contracts.ts";
import type { Client } from "./client.ts";

type Flags = Record<string, string | boolean | string[]>;
export async function artifactCommand(client: Client, p: string[], f: Flags) {
  const verb = p[1],
    id = p[2],
    text = (key: string) => (typeof f[key] === "string" ? (f[key] as string) : undefined);
  const print = (v: unknown) => console.log(JSON.stringify(v, null, f.json ? undefined : 2));
  const key = text("key") ?? randomUUID(),
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
  const inputFile = () => (f.input ? JSON.parse(readFileSync(String(f.input), "utf8")) : {});
  const body = () => (f["body-file"] ? readFileSync(String(f["body-file"]), "utf8") : text("body"));
  const detail = () => client.call<ArtifactDetail>("artifacts_get", { artifact_id: id });
  const version = async () =>
    f.version ? Number(f.version) : ((await detail()).versions.at(-1)?.seq ?? 0);
  if (verb === "create") {
    const remote = f.remote
      ? text("remote")
      : (await detectPublisherRemote(process.cwd())).remote?.url;
    print(
      await call("artifacts_create", {
        kind: text("kind") ?? "files",
        title: text("title"),
        project_id: text("project"),
        task_id: text("task"),
        remote_url: remote,
      }),
    );
    return;
  }
  if (verb === "publish") {
    const d = await detail(),
      root = resolve(text("root") ?? ".");
    let content: Record<string, unknown>;
    if (f.input) content = inputFile();
    else if (d.kind === "diff") {
      const patch = f.patch
        ? readFileSync(String(f.patch), "utf8")
        : f.commit
          ? await captureGitCommit(root, String(f.commit))
          : f.base
            ? await captureGitDiff(root, String(f.base), text("head") ?? "WORKING")
            : null;
      if (patch === null)
        throw new Error(
          "Diff publication needs --patch FILE, --commit SHA, or --base REF [--head REF|WORKING|STAGED]",
        );
      content = { kind: "diff", patch };
    } else {
      const paths = (f.path as string[] | undefined) ?? ["."];
      content = {
        kind: d.kind,
        files: f.ref
          ? await captureGitFiles(root, String(f.ref), paths)
          : await captureFiles(root, paths),
      };
    }
    print(
      await call("artifacts_publish", {
        artifact_id: id,
        expected_seq: f["expected-seq"] ? Number(f["expected-seq"]) : (d.versions.at(-1)?.seq ?? 0),
        content,
        label: text("label"),
        summary: text("summary"),
        task_id: text("task"),
        listen: !f["no-listen"],
      }),
    );
    return;
  }
  if (verb === "list" || verb === "search") {
    print(
      await client.call(verb === "list" ? "artifacts_list" : "artifacts_search", {
        query: id,
        project_id: text("project"),
        state: text("state"),
        kind: text("kind"),
        history: f.all ? "all" : "latest",
        cursor: f.cursor ? Number(f.cursor) : 0,
        limit: f.limit ? Number(f.limit) : 50,
      }),
    );
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
    if (!f.output) throw new Error("Supply --output FILE");
    const path =
      verb === "image"
        ? `${base()}/attachments/${encodeURIComponent(String(f.image))}`
        : `${base()}/versions/${await version()}/${verb === "patch" ? "patch" : `resource?path=${encodeURIComponent((f.path as string[])?.[0] ?? "")}`}`;
    const bytes = new Uint8Array(await (await client.request(path)).arrayBuffer());
    writeFileSync(String(f.output), bytes, { flag: "wx", mode: 0o600 });
    print({ saved: true, bytes: bytes.length });
    return;
  }
  if (verb === "comments") {
    const result = (await get(
      `${base()}/comments/${f.all ? "history" : "pending"}${f.threads ? `?threads=${encodeURIComponent(String(f.threads))}` : ""}`,
    )) as {
      text: string;
      acknowledgment?: ArtifactCommentAcknowledgment;
      attachments: ArtifactAttachment[];
    };
    const files: Record<string, string> = {};
    if (f["attachments-dir"]) {
      const dir = resolve(String(f["attachments-dir"]));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const attachment of result.attachments) {
        const bytes = new Uint8Array(
          await (
            await client.request(`${base()}/attachments/${encodeURIComponent(attachment.id)}`)
          ).arrayBuffer(),
        );
        if (hashBytes(bytes) !== attachment.hash) throw new Error("Attachment hash mismatch");
        const output = join(
          dir,
          attachment.id + "." + (attachment.mediaType === "image/png" ? "png" : "jpg"),
        );
        writeFileSync(output, bytes, { mode: 0o600 });
        files[attachment.id] = output;
      }
    }
    // An EPIPE or failed attachment write must leave the exact discussion snapshot undelivered.
    const output = f.json
      ? JSON.stringify({ ...result, files })
      : result.text +
        (Object.keys(files).length ? `\nSaved attachments: ${JSON.stringify(files)}\n` : "");
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(output + "\n", (error) => (error ? reject(error) : resolve())),
    );
    if (result.acknowledgment && !f.all && !f["no-ack"])
      await call("artifact_comments_ack", { artifact_id: id, receipt: result.acknowledgment });
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
    const input = {
      ...inputFile(),
      ...(body() === undefined ? {} : { body: body() }),
      ...(f.target ? { target: JSON.parse(String(f.target)) } : {}),
      ...(f.status ? { status: f.status } : {}),
    };
    if (verb === "thread-add" && !("target" in input))
      Object.assign(input, { target: { kind: "artifact" } });
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
    print(await call("artifact_threads_reanchor", { artifact_id: id, input: inputFile() }));
    return;
  }
  if (verb === "edit") {
    print(
      await call("artifacts_edit", {
        artifact_id: id,
        input: { ...inputFile(), ...(f.title ? { title: f.title } : {}) },
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
