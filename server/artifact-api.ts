import { randomUUID } from "node:crypto";
import { type Context, Hono } from "hono";
import { AppError, can, type Operation, type Principal } from "../shared/contracts.ts";
import type { Auth } from "./auth.ts";
import { artifactJson, artifactJsonResponse } from "./r3/server/artifact-http.ts";
import { artifactResourceResponse } from "./r3/server/artifact-resources.ts";
import { parseArtifactSearch } from "./r3/server/artifact-search.ts";
import { artifactSourceResponse } from "./r3/server/artifact-source.ts";
import {
  ArtifactError,
  requireArtifactPath,
  requireSequence,
} from "./r3/server/artifact-validation.ts";
import { listThemes, themeStyle } from "./r3/server/highlight.ts";
import { renderStoredPatch, storedPatchContext } from "./r3/server/patch-content.ts";
import { buildArtifactPrompt, commentAttachments } from "./r3/shared/artifact-prompt.ts";
import type { Workspace } from "./workspace.ts";

type Input = Record<string, unknown>;
const param = (c: Context, key: string) => {
  const value = c.req.param(key);
  if (!value) throw new AppError("invalid_route", "Missing route parameter");
  return value;
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
export function artifactApi(w: Workspace, auth: Auth) {
  const api = new Hono(),
    service = w.artifacts;
  if (!service) return api;
  const principal = (c: Context, write = false): Principal => {
    const p = auth.principal(c.req.raw);
    if (!p) throw new AppError("unauthorized", "Sign in to Allgather", 401);
    if (!can(p, write ? "artifacts:write" : "artifacts:read"))
      throw new AppError("forbidden", "Artifact access is not granted", 403);
    return p;
  };
  const get = (path: string, handler: (c: Context) => Response | Promise<Response>) =>
    api.get(path, (c) => {
      principal(c);
      return handler(c);
    });
  const body = async (c: Context, limit = 32 * 1024 * 1024) => {
    principal(c, true);
    return (await artifactJson(c.req.raw, limit)) as Input;
  };
  const metadata = (b: Input) => {
    const actor = b.actor as Input | undefined;
    if (!actor) return {};
    if (actor.role === "human") return { operator_kind: "user" };
    if (actor.role === "agent" && typeof actor.sessionId === "string")
      return { operator_kind: "agent", session_id: actor.sessionId };
    throw new AppError("invalid_actor", "Invalid artifact actor");
  };
  const write = async (c: Context, name: Operation, args: Input, b: Input = {}) =>
    w.dispatch(
      name,
      {
        ...metadata(b),
        ...args,
        operation_key:
          typeof b.operationKey === "string"
            ? b.operationKey
            : (c.req.header("x-allgather-operation-key") ?? randomUUID()),
      },
      principal(c, true),
    );
  const seq = (c: Context) => requireSequence(Number(param(c, "seq")));
  api.onError((e) =>
    json(
      { error: e.message, code: e instanceof AppError ? e.code : "artifact_error" },
      e instanceof AppError || e instanceof ArtifactError ? e.status : 500,
    ),
  );
  get("/api/artifacts", (c) =>
    json(
      service.store.list({
        state: c.req.query("state") as "active" | "archived" | undefined,
        kind: c.req.query("kind") as "files" | "html" | "diff" | undefined,
        projectId: c.req.query("project"),
      }),
    ),
  );
  get("/api/artifacts/:id", (c) =>
    artifactJsonResponse(
      c.req.raw,
      c.req.query("view") === "summary"
        ? service.store.get(param(c, "id"))
        : service.detail(param(c, "id")),
    ),
  );
  get("/api/projects", () => json(service.store.projects()));
  get("/api/themes", () => json(listThemes()));
  get("/api/theme-style", async (c) => json(await themeStyle(c.req.query("theme"))));
  get("/api/search", async (c) =>
    json(await service.search.search(parseArtifactSearch(new URL(c.req.url).searchParams))),
  );
  get("/api/library-summary", (c) =>
    json(service.usage.stat(c.req.query("window") === "weekly" ? "weekly" : "daily")),
  );
  api.post("/api/gc", async (c) => {
    const b = await body(c);
    return json(await write(c, "artifacts_gc", { input: b }, b));
  });
  api.post("/api/artifacts", async (c) => {
    const b = await body(c);
    return json(
      await write(
        c,
        "artifacts_create",
        {
          kind: b.kind,
          title: b.title,
          project_id: b.projectId,
          meta: b.meta,
          remote_url: b.remoteUrl,
        },
        b,
      ),
      201,
    );
  });
  api.patch("/api/artifacts/:id", async (c) => {
    const b = await body(c);
    return json(await write(c, "artifacts_edit", { artifact_id: param(c, "id"), input: b }, b));
  });
  api.delete("/api/artifacts/:id", async (c) =>
    json(await write(c, "artifacts_delete", { artifact_id: param(c, "id") })),
  );
  api.post("/api/artifacts/:id/versions", async (c) => {
    const b = await body(c, 192 * 1024 * 1024);
    return json(
      await write(
        c,
        "artifacts_publish",
        {
          artifact_id: param(c, "id"),
          expected_seq: b.expectedSeq,
          content: b.content,
          label: b.label,
          summary: b.summary,
          provenance: b.provenance,
          listen: b.listen,
        },
        { ...b, operationKey: b.publicationKey },
      ),
      201,
    );
  });
  get("/api/artifacts/:id/versions", (c) => json(service.store.versions(param(c, "id"))));
  get("/api/artifacts/:id/versions/:seq", (c) =>
    json(service.store.version(param(c, "id"), seq(c))),
  );
  get("/api/artifacts/:id/versions/:seq/files", (c) =>
    json(service.store.files(param(c, "id"), seq(c))),
  );
  get("/api/artifacts/:id/versions/:seq/source", (c) =>
    artifactSourceResponse(
      service.store,
      c.req.raw,
      param(c, "id"),
      seq(c),
      requireArtifactPath(c.req.query("path")),
      c.req.query("theme"),
    ),
  );
  get("/api/artifacts/:id/versions/:seq/resource", (c) =>
    artifactResourceResponse(
      service.store,
      c.req.raw,
      param(c, "id"),
      seq(c),
      requireArtifactPath(c.req.query("path")),
    ),
  );
  get(
    "/api/artifacts/:id/versions/:seq/patch",
    (c) =>
      new Response(service.store.patch(param(c, "id"), seq(c)), {
        headers: {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="publication.patch"',
          "content-security-policy": "sandbox; default-src 'none'",
        },
      }),
  );
  get("/api/artifacts/:id/versions/:seq/diff", async (c) =>
    artifactJsonResponse(
      c.req.raw,
      await renderStoredPatch(service.store.patch(param(c, "id"), seq(c)), c.req.query("theme")),
    ),
  );
  get("/api/artifacts/:id/versions/:seq/diff-context", async (c) => {
    const path = requireArtifactPath(c.req.query("path")),
      lines = await storedPatchContext(
        service.store.patch(param(c, "id"), seq(c)),
        path,
        requireSequence(Number(c.req.query("start"))),
        requireSequence(Number(c.req.query("end"))),
        c.req.query("theme"),
      );
    if (!lines) throw new ArtifactError("Captured context not found", 404);
    return artifactJsonResponse(c.req.raw, { path, lines });
  });
  api.post("/api/artifacts/:id/versions/:seq/previews", async (c) => {
    principal(c);
    const b = await artifactJson(c.req.raw, 4096);
    return json(
      service.previews.create(
        param(c, "id"),
        seq(c),
        requireArtifactPath(b.path),
        auth.baseUrl,
        b.network,
      ),
      201,
    );
  });
  api.patch("/api/previews/:id", (c) => {
    principal(c);
    return json(service.previews.renew(param(c, "id")));
  });
  api.delete("/api/previews/:id", (c) => {
    principal(c);
    service.previews.revoke(param(c, "id"));
    return json({ ok: true });
  });
  get("/api/artifacts/:id/attachments/:image", async (c) => {
    const { attachment, bytes } = await service.store.attachments.read(
      param(c, "id"),
      param(c, "image"),
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": attachment.mediaType,
        "content-length": String(bytes.length),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
      },
    });
  });
  get("/api/artifacts/:id/threads", (c) =>
    artifactJsonResponse(c.req.raw, service.conversations.list(param(c, "id"))),
  );
  get("/api/threads/:id", (c) => json(service.conversations.get(param(c, "id"))));
  get("/api/threads/:id/source", async (c) =>
    json(await service.conversations.source(param(c, "id"))),
  );
  get("/api/threads/:id/anchor-resolution", async (c) =>
    json(
      await service.conversations.anchors.resolve(
        param(c, "id"),
        requireSequence(Number(c.req.query("version"))),
      ),
    ),
  );
  api.post("/api/artifacts/:id/threads", async (c) => {
    const b = await body(c);
    return json(
      await write(c, "artifact_threads_add", { artifact_id: param(c, "id"), input: b }, b),
      201,
    );
  });
  api.patch("/api/threads/:id", async (c) => {
    const b = await body(c);
    return json(
      await write(c, "artifact_threads_edit", { thread_id: param(c, "id"), input: b }, b),
    );
  });
  api.delete("/api/threads/:id", async (c) => {
    const b = await body(c);
    return json(await write(c, "artifact_threads_delete", { thread_id: param(c, "id") }, b));
  });
  api.post("/api/threads/:id/comments", async (c) => {
    const b = await body(c);
    return json(
      await write(c, "artifact_comments_add", { thread_id: param(c, "id"), input: b }, b),
      201,
    );
  });
  get("/api/comments/:id", (c) => json(service.conversations.comment(param(c, "id"))));
  api.patch("/api/comments/:id", async (c) => {
    const b = await body(c);
    return json(
      await write(c, "artifact_comments_edit", { comment_id: param(c, "id"), input: b }, b),
    );
  });
  api.post("/api/artifacts/:id/thread-anchors", async (c) => {
    const b = await body(c);
    return json(
      await write(c, "artifact_threads_reanchor", { artifact_id: param(c, "id"), input: b }, b),
    );
  });
  get("/api/artifacts/:id/comments/pending", (c) => {
    const id = param(c, "id"),
      s = service.conversations.snapshot(id, c.req.query("threads")?.split(","));
    return json({
      ...s,
      text: buildArtifactPrompt(service.detail(id), s.threads, true, s.comments),
      itemCount: s.threads.length + s.comments.length,
      attachments: commentAttachments(s.threads, true),
    });
  });
  get("/api/artifacts/:id/comments/history", (c) => {
    const id = param(c, "id"),
      threads = service.conversations.list(id),
      comments = service.conversations.artifactComments(id);
    return json({
      threads,
      comments,
      text: buildArtifactPrompt(service.detail(id), threads, false, comments),
      itemCount: threads.length + comments.length,
      attachments: commentAttachments(threads),
    });
  });
  api.post("/api/artifacts/:id/comments/acknowledge", async (c) => {
    const b = await body(c),
      result = await write(
        c,
        "artifact_comments_ack",
        { artifact_id: param(c, "id"), receipt: b },
        b,
      );
    return json({ acknowledgedCount: Array.isArray(result) ? result.length : 0 });
  });
  api.post("/api/artifacts/:id/lifecycle", async (c) => {
    const b = await body(c);
    if (!["archived", "restored"].includes(String(b.event)))
      throw new ArtifactError("Invalid lifecycle event");
    const result = (await write(
      c,
      b.event === "archived" ? "artifacts_archive" : "artifacts_restore",
      { artifact_id: param(c, "id"), comment: (b.comment as Input | undefined)?.body },
      b,
    )) as Input;
    return json(result);
  });
  api.post("/api/artifacts/archive", async (c) => {
    const b = await body(c);
    if (!Array.isArray(b.items) || b.items.length > 100)
      throw new ArtifactError("Supply up to 100 archive items");
    const results = [];
    for (const item of b.items as Input[]) {
      try {
        const result = (await write(
          c,
          "artifacts_archive",
          { artifact_id: item.id, comment: (b.comment as Input | undefined)?.body },
          { ...b, operationKey: item.operationKey },
        )) as { event: { id: string }; replayed: boolean; notification: { state: string } };
        results.push({
          id: item.id,
          state: "archived",
          eventId: result.event.id,
          replayed: result.replayed,
          notification: result.notification ?? { state: "none" },
        });
      } catch (e) {
        if (
          w.one<{ state: string }>("SELECT state FROM artifacts WHERE id=?", String(item.id))
            ?.state === "archived"
        )
          results.push({ id: item.id, state: "skipped", reason: "already_archived" });
        else
          results.push({
            id: item.id,
            state: "failed",
            status: e instanceof AppError ? e.status : 500,
            error: e instanceof Error ? e.message : "Archive failed",
          });
      }
    }
    return json({ results });
  });
  get("/api/artifacts/:id/watchers", (c) => json(service.notifications.watchers(param(c, "id"))));
  api.post("/api/artifacts/:id/submit", async (c) =>
    json(await write(c, "artifacts_submit", { artifact_id: param(c, "id") })),
  );
  get("/api/artifacts/:id/viewed", (c) => json(service.store.viewed(param(c, "id"))));
  api.put("/api/artifacts/:id/viewed", async (c) => {
    const b = await body(c);
    return json(
      await write(c, "artifacts_mark_viewed", { artifact_id: param(c, "id"), input: b }, b),
    );
  });
  return api;
}
