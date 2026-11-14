import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import type { Artifact, ArtifactPreviewNetwork } from "../shared/artifacts.ts";
import { operations, type Principal } from "../shared/contracts.ts";

const owner: Principal = { id: "owner", kind: "owner", inlet: "browser", scopes: ["admin"] };
const sandboxed = /(?:^|;)\s*sandbox(?:\s|;|$)/;

test("every preview response is sandboxed, including errors, revalidations and stale contexts", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-preview-isolation-")),
    db = openDatabase(":memory:"),
    w = new Workspace(db, undefined, undefined, { dataDir: root }),
    app = "http://localhost:4390";
  const file = (path: string, mediaType: string, body: string) => ({
    path,
    mediaType,
    base64: Buffer.from(body).toString("base64"),
  });
  const call = <T>(name: "artifacts_create" | "artifacts_publish", input: object) =>
    w.dispatch(
      name,
      { ...(operations[name].write ? { operation_key: randomUUID() } : {}), ...input },
      owner,
    ) as Promise<T>;
  try {
    const artifact = await call<Artifact>("artifacts_create", { kind: "html", title: "Isolation" });
    await call("artifacts_publish", {
      artifact_id: artifact.id,
      expected_seq: 0,
      listen: false,
      content: {
        kind: "html",
        files: [
          file("index.html", "text/html", `<h1>Page</h1>${"<p>pad</p>".repeat(200)}`),
          file("style.css", "text/css", "h1{color:red}"),
          file("notes.md", "text/markdown", "# Notes"),
        ],
      },
    });
    const media = await call<Artifact>("artifacts_create", { kind: "files", title: "Media" });
    await call("artifacts_publish", {
      artifact_id: media.id,
      expected_seq: 0,
      listen: false,
      content: {
        kind: "files",
        files: [file("pic.svg", "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'/>")],
      },
    });
    const previews = w.artifacts!.previews;
    const send = (url: string, init: RequestInit & { dest?: string } = {}) => {
      const headers = new Headers(init.headers);
      if (!headers.has("host")) headers.set("host", new URL(url).host);
      if (init.dest) headers.set("sec-fetch-dest", init.dest);
      return previews.fetch(new Request(url, { ...init, headers }), new Set([app]));
    };
    const responses: [string, Response][] = [];
    const record = async (label: string, response: Promise<Response>) => {
      responses.push([label, await response]);
      return responses.at(-1)![1];
    };
    for (const [id, path, network] of [
      [artifact.id, "index.html", "blocked"],
      [artifact.id, "index.html", "compatible"],
      [artifact.id, "index.html", "external"],
      [artifact.id, "notes.md", "blocked"],
      [media.id, "pic.svg", "blocked"],
    ] as [string, string, ArtifactPreviewNetwork][]) {
      const context = previews.create(id, 1, path, app, network),
        base = context.resourceRoot,
        label = (name: string) => `${network} ${path} ${name}`;
      const document = await record(
        label("document"),
        send(context.documentUrl, { dest: "iframe" }),
      );
      expect(document.status).toBe(200);
      const etag = document.headers.get("etag");
      if (etag)
        expect(
          (
            await record(
              label("revalidated"),
              send(context.documentUrl, { dest: "iframe", headers: { "if-none-match": etag } }),
            )
          ).status,
        ).toBe(304);
      await record(
        label("gzip"),
        send(context.documentUrl, { dest: "iframe", headers: { "accept-encoding": "gzip" } }),
      );
      await record(label("head"), send(context.documentUrl, { dest: "iframe", method: "HEAD" }));
      for (const [name, url, init] of [
        ["gate", context.gateUrl, { dest: "iframe" }],
        ["top-level", context.documentUrl, { dest: "document" }],
        ["runtime", `${base}/r3/runtime.js`, { dest: "script" }],
        ["utility", context.utilityUrl, { dest: "script" }],
        ["check", `${base}/r3/check`, {}],
        ["markdown", `${base}/r3/markdown?path=notes.md`, {}],
        ["markdown-missing", `${base}/r3/markdown?path=index.html`, {}],
        ["markdown-invalid", `${base}/r3/markdown?path=..%2Fx`, {}],
        ["media", `${base}/r3/media`, { dest: "iframe" }],
        ["stylesheet", `${base}/files/style.css`, { dest: "style" }],
        ["missing", `${base}/files/missing.html`, { dest: "iframe" }],
        ["malformed", `${base}/files/%E0%A4%A`, {}],
        ["unknown", `${base}/elsewhere`, {}],
        ["post", context.documentUrl, { method: "POST", body: "x" }],
        ["service-worker", `${base}/files/style.css`, { dest: "serviceworker" }],
        ["wrong-host", context.documentUrl, { headers: { host: "evil.example" } }],
      ] as [string, string, RequestInit & { dest?: string }][])
        await record(label(name), send(url, init));
      previews.revoke(context.id);
      await record(label("revoked"), send(context.documentUrl, { dest: "iframe" }));
    }
    await record(
      "unknown context",
      send(`${app}/__r3_preview/p${"0".repeat(48)}/files/index.html`),
    );
    await record("no context", send(`${app}/__r3_preview/`));
    expect(responses.length).toBeGreaterThan(100);
    for (const [label, response] of responses)
      expect([label, response.headers.get("content-security-policy") ?? ""]).toEqual([
        label,
        expect.stringMatching(sandboxed),
      ]);
  } finally {
    w.artifacts?.previews.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
