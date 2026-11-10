import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureApiToken, fixtureLogin } from "../scripts/fixture-auth.ts";
import { startServer } from "../server/index.ts";
import { redIcon } from "./fixtures/project-icons.ts";

const cli = resolve("cli/index.ts");
test("artifact CLI publishes, filters, targets, reanchors, delivers and streams through the server", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-artifact-cli-"));
  const running = await startServer({
    dataDir: join(root, "state"),
    port: 0,
    ownerUrl: "http://localhost:0",
  });
  const home = join(root, "home"),
    capture = join(root, "capture");
  mkdirSync(home);
  mkdirSync(capture);
  writeFileSync(join(capture, "note.txt"), "first\nsecond\nthird\n");
  writeFileSync(join(capture, "binary.bin"), Buffer.from([0, 255, 128, 10]));
  const png = join(root, "image.png");
  writeFileSync(png, Buffer.from(redIcon, "base64"));
  const env = {
    ALLGATHER_OPERATOR_KIND: "user",
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    ALLGATHER_CONFIG_DIR: join(home, "allgather"),
    ALLGATHER_URL: running.settings.ownerUrl,
    ALLGATHER_TOKEN: await fixtureApiToken(
      running.settings.ownerUrl,
      await fixtureLogin(join(root, "state"), running.settings.ownerUrl),
    ),
  };
  const invoke = async (args: string[], stdin?: string) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, "artifact", ...args], {
      cwd: root,
      env,
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [bytes, err, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const out = Buffer.from(bytes);
    return { out, err, code, json: () => JSON.parse(out.toString()) };
  };
  const ok = async (...args: string[]) => {
    const result = await invoke(args);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    return result.json();
  };
  try {
    const created = await ok(
      "create",
      "--kind",
      "files",
      "--root",
      capture,
      "--key",
      "create-review",
      "--meta",
      "topic=review",
      "--meta",
      "session=reviewer",
    );
    const id = created.id;
    expect(created.publication.seq).toBe(1);
    expect(created.url).toBe(`${running.settings.ownerUrl}/?view=artifacts&artifact=${id}`);
    expect(
      (
        await ok(
          "create",
          "--kind",
          "files",
          "--root",
          capture,
          "--key",
          "create-review",
          "--meta",
          "topic=review",
          "--meta",
          "session=reviewer",
        )
      ).id,
    ).toBe(id);
    expect((await ok("versions", id)).length).toBe(1);
    expect(
      (await ok("list", "--meta", "topic=review")).items.map((v: { id: string }) => v.id),
    ).toEqual([id]);
    expect((await ok("list", "--meta", "topic=other")).items).toEqual([]);
    expect(
      (await ok("list", "--mine", "--session", "reviewer")).items.map((v: { id: string }) => v.id),
    ).toEqual([id]);
    expect(
      (await invoke(["search", "first", "--attention", "--type", "content", "--history", "all"]))
        .code,
    ).toBe(0);
    const download = await invoke(["download", id, "--path", "binary.bin"]);
    expect(download.code).toBe(0);
    expect(download.out).toEqual(Buffer.from([0, 255, 128, 10]));
    const saved = join(root, "saved.bin");
    await ok("download", id, "--path", "binary.bin", "--output", saved);
    expect((await invoke(["download", id, "--path", "note.txt", "--output", saved])).code).toBe(1);
    expect(readFileSync(saved)).toEqual(download.out);
    const thread = await ok(
      "thread-add",
      id,
      "--body",
      "Review this",
      "--file",
      "note.txt",
      "--version",
      "1",
      "--view",
      "source",
      "--line",
      "1-2",
      "--quote",
      "first",
      "--attach",
      png,
    );
    expect(thread.comments[0].attachments).toHaveLength(1);
    expect(thread.target.locator).toMatchObject({ start: 1, end: 2, quote: "first" });
    const images = join(root, "images");
    const history = await ok("comments", id, "--all", "--attachments-dir", images, "--json");
    const imageFile = Object.values(history.files)[0] as string;
    await ok("comments", id, "--all", "--attachments-dir", images, "--json");
    const image = await invoke(["image", id, "--image", thread.comments[0].attachments[0].id]);
    expect(image.out).toEqual(readFileSync(imageFile));
    writeFileSync(imageFile, "do not overwrite");
    expect((await invoke(["comments", id, "--attachments-dir", images])).code).toBe(1);
    expect(readFileSync(imageFile, "utf8")).toBe("do not overwrite");
    writeFileSync(imageFile, image.out);
    const pending = await ok("comments", id, "--json", "--no-ack");
    expect(pending.itemCount).toBeGreaterThan(0);
    const delivered = await invoke([
      "comments",
      id,
      "--json",
      "--session",
      "reviewer",
      "--operator-kind",
      "agent",
    ]);
    expect(delivered.code).toBe(0);
    expect(delivered.err).toBe("");
    expect((await ok("watchers", id)).length).toBeGreaterThan(0);
    expect((await ok("comments", id, "--json")).itemCount).toBe(0);
    expect((await invoke(["watch", id, "--timeout", "0.01"])).code).toBe(2);
    await ok("publish", id, "--root", capture, "--expected-seq", "1", "--key", "publish-next");
    const moved = await ok(
      "reanchor",
      thread.id,
      "--file",
      "note.txt",
      "--version",
      "2",
      "--view",
      "source",
      "--line",
      "2",
      "--key",
      "move",
    );
    expect(moved.results[0].revision).toBe(1);
    expect(
      (
        await invoke([
          "reanchor",
          thread.id,
          "--file",
          "note.txt",
          "--version",
          "2",
          "--view",
          "source",
          "--line",
          "3",
          "--expected-anchor",
          "0",
        ])
      ).code,
    ).toBe(1);
    const reply = await ok(
      "comment",
      thread.id,
      "--body",
      "Fixed",
      "--file",
      "note.txt",
      "--version",
      "2",
      "--view",
      "source",
      "--line",
      "3",
      "--quote",
      "third",
      "--key",
      "reply",
    );
    expect(reply.body).toBe("Fixed");
    expect((await ok("show", id)).threads[0].anchor.revision).toBe(2);
    await ok(
      "comment",
      thread.id,
      "--body",
      "Historical",
      "--file",
      "note.txt",
      "--version",
      "1",
      "--view",
      "source",
    );
    expect((await ok("show", id)).threads[0].anchor.revision).toBe(2);
    const batch = await invoke(
      ["reanchor", "--artifact", id, "--version", "2", "--input", "-"],
      JSON.stringify([
        {
          threadId: thread.id,
          expectedAnchorRevision: 2,
          target: { kind: "source", path: "note.txt", versionSeq: 2, locator: null },
        },
      ]),
    );
    expect(batch.code).toBe(0);
    expect(batch.json().results[0].revision).toBe(3);
    await ok("thread-edit", thread.id, "--body", "Updated", "--clear-attachments");
    expect((await ok("show", id)).threads[0].comments[0].attachments).toEqual([]);
    expect(
      (
        await invoke([
          "watch",
          id,
          "--timeout",
          "1",
          "--operator-kind",
          "agent",
          "--agent-type",
          "fixture",
        ])
      ).code,
    ).toBe(10);
    expect(
      running.workspace.one(
        "SELECT operator_id,operator_kind,session_id FROM audit_operations WHERE operation='artifact_comments_ack' ORDER BY rowid DESC LIMIT 1",
      ),
    ).toMatchObject({ operator_id: "operator-owner", operator_kind: "user", session_id: null });
    expect((await ok("comments", id, "--json")).itemCount).toBe(0);
    await ok("archive", id);
    expect((await invoke(["watch", id, "--timeout", "0.001"])).code).toBe(0);
    await ok("restore", id);
    await ok("thread-delete", thread.id);
    expect((await ok("show", id)).threads).toEqual([]);
    const empty = await ok("create", "--kind", "files");
    expect(await ok("versions", empty.id)).toEqual([]);
    const rejected = await invoke([
      "create",
      "--kind",
      "files",
      "--root",
      capture,
      "--typo",
      "value",
    ]);
    expect(rejected.code).toBe(1);
    expect(rejected.err).toContain("Unsupported --typo");
    const conflict = await invoke([
      "publish",
      id,
      "--root",
      capture,
      "--expected-seq",
      "0",
      "--key",
      "preserved",
    ]);
    expect(conflict.code).toBe(1);
    expect(conflict.err).toContain('"key":"preserved","expected_seq":0');
    const patchText =
      "diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const diff = await invoke(["create", "--kind", "diff", "--patch", "-"], patchText);
    expect(diff.code).toBe(0);
    expect((await invoke(["patch", diff.json().id])).out.toString()).toBe(patchText);
    await ok(
      "thread-add",
      diff.json().id,
      "--body",
      "New line",
      "--file",
      "note.txt",
      "--version",
      "1",
      "--view",
      "diff",
      "--line",
      "1",
      "--quote",
      "new",
      "--side",
      "new",
    );
    writeFileSync(join(capture, "index.html"), '<h1 id="heading">Review</h1><img src="image.png">');
    writeFileSync(join(capture, "image.png"), Buffer.from(redIcon, "base64"));
    const html = await ok("create", "--kind", "html", "--root", capture);
    await ok(
      "thread-add",
      html.id,
      "--body",
      "Heading",
      "--file",
      "index.html",
      "--version",
      "1",
      "--view",
      "rendered",
      "--selector",
      "#heading",
      "--quote",
      "Review",
      "--route",
      "#review",
    );
    const mediaArtifact = await ok(
      "create",
      "--kind",
      "files",
      "--root",
      capture,
      "--path",
      "image.png",
    );
    const media = await ok(
      "thread-add",
      mediaArtifact.id,
      "--body",
      "Image",
      "--target",
      JSON.stringify({
        kind: "media",
        versionSeq: 1,
        path: "image.png",
        locator: { time: null, box: { x: 0, y: 0, width: 1, height: 1 } },
      }),
      "--frame",
      png,
    );
    expect(media.target.locator.frame.mediaType).toBe("image/png");
    const edit = await ok("comment-edit", media.comments[0].id, "--attach", png);
    expect(edit.attachments).toHaveLength(1);
    expect(
      (await ok("comment-edit", media.comments[0].id, "--clear-attachments")).attachments,
    ).toEqual([]);
    const mine = await ok(
      "create",
      "--kind",
      "files",
      "--operator-kind",
      "agent",
      "--session",
      "new-reviewer",
    );
    expect(
      (await ok("list", "--mine", "--session", "new-reviewer")).items.map(
        (v: { id: string }) => v.id,
      ),
    ).toEqual([mine.id]);
    for (const topic of ["files", "html", "diff"])
      expect((await invoke(["guide", topic])).code).toBe(0);
  } finally {
    await running.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
