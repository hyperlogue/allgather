import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, Updates } from "../server/app.ts";
import { Auth } from "../server/auth.ts";
import { backupWorkspace, restoreWorkspace } from "../server/backup.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import { type Operation, operations, type Principal, type Project } from "../shared/contracts.ts";
import { PROJECT_ICON_MAX_BYTES } from "../shared/project-icon.ts";
import { blueIcon, redIcon } from "./fixtures/project-icons.ts";

const owner: Principal = { id: "owner", kind: "owner", scopes: ["admin"], inlet: "browser" };
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const w = new Workspace(db);
  const call = <T>(name: Operation, input: Record<string, unknown>, principal = owner) =>
    w.execute(
      name,
      { ...(operations[name].write ? { operation_key: randomUUID() } : {}), ...input },
      principal,
    ) as T;
  const upload = (base64: string) => ({ media_type: "image/png", base64 });
  return { db, w, call, upload };
}

test("project icons create, replace, preserve on other edits, clear, and retry atomically", () => {
  const { db, w, call, upload } = setup();
  let p = call<Project>("projects_create", { name: "Images", icon: upload(redIcon) });
  expect(p.icon?.media_type).toBe("image/png");
  expect(p.icon?.hash).toHaveLength(64);
  expect(JSON.stringify(p)).not.toContain(redIcon);
  const initial = p.icon;
  p = call("projects_update", {
    project_id: p.id,
    expected_revision: p.revision,
    body: "Other edit",
  });
  expect(p.icon).toEqual(initial);
  const replace = {
    project_id: p.id,
    expected_revision: p.revision,
    icon: upload(blueIcon),
    operation_key: "replace-once",
  };
  p = call("projects_update", replace);
  expect(call<Project>("projects_update", replace)).toEqual(p);
  expect(p.icon).not.toEqual(initial);
  expect(() => call("projects_update", { ...replace, operation_key: "stale" })).toThrow("revision");
  expect(() =>
    call("projects_update", {
      project_id: p.id,
      expected_revision: p.revision,
      name: "Bad update",
      icon: upload("AAAA"),
    }),
  ).toThrow("valid static");
  expect(w.project(p.id)).toMatchObject({ name: p.name, revision: p.revision, icon: p.icon });
  expect(() => call("projects_create", { name: "Broken", icon: upload("AAAA") })).toThrow();
  expect(db.query("SELECT 1 FROM projects WHERE name='Broken'").get()).toBeNull();
  const audit = db
    .query<{ after_value: string }, []>(
      "SELECT after_value FROM audit_changes WHERE entity_type='project_icons' AND change_kind='insert'",
    )
    .get()!;
  expect(JSON.parse(audit.after_value)).not.toHaveProperty("bytes");
  expect(call<Project[]>("projects_list", {}).find((item) => item.id === p.id)?.icon).toEqual(
    p.icon,
  );
  p = call("projects_update", { project_id: p.id, expected_revision: p.revision, icon: null });
  expect(p.icon).toBeNull();
  expect(db.query("SELECT count(*) n FROM project_icons").get()).toEqual({ n: 0 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("project icon uploads reject invalid encodings, formats and oversized input", () => {
  const { call, upload } = setup();
  for (const icon of [
    upload(""),
    upload(redIcon + "!"),
    upload("A".repeat(4 * Math.ceil(PROJECT_ICON_MAX_BYTES / 3) + 4)),
    {
      media_type: "image/svg+xml",
      base64: Buffer.from('<svg onload="alert(1)"/>').toString("base64"),
    },
    { media_type: "image/jpeg", base64: redIcon },
  ])
    expect(() => call("projects_create", { name: "Invalid", icon })).toThrow();
  expect(call<Project[]>("projects_list", {})).toEqual([]);
});

test("icon reads authorize before conditional caching and preserve resource grants", async () => {
  const { db, w, call, upload } = setup();
  let project = call<Project>("projects_create", { name: "Private icon", icon: upload(redIcon) });
  const other = call<Project>("projects_create", { name: "Other" });
  const auth = new Auth(db, "http://localhost");
  let principal: Principal | null = owner;
  const authentication = spyOn(auth, "principal").mockImplementation(() => principal);
  const app = createApp(w, auth, new Updates());
  const read = (etag?: string) =>
    app.fetch(
      new Request(`http://localhost/api/projects/${project.id}/icon`, {
        headers: etag ? { "if-none-match": etag } : {},
      }),
    );
  try {
    const first = await read();
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(Buffer.from(await first.arrayBuffer()).toString("base64")).toBe(redIcon);
    const etag = first.headers.get("etag")!;
    expect((await read(etag)).status).toBe(304);
    principal = {
      id: "restricted",
      kind: "client",
      scopes: ["projects:read", "projects:write"],
      inlet: "api",
      resources: { project_ids: [other.id], machine_ids: [], unassigned: false },
    };
    expect((await read(etag)).status).toBe(403);
    expect(() =>
      call(
        "projects_update",
        { project_id: project.id, expected_revision: project.revision, icon: null },
        principal!,
      ),
    ).toThrow();
    principal = null;
    expect((await read(etag)).status).toBe(401);
    principal = owner;
    project = call("projects_update", {
      project_id: project.id,
      expected_revision: project.revision,
      icon: upload(blueIcon),
    });
    expect((await read(etag)).status).toBe(200);
    call("projects_update", {
      project_id: project.id,
      expected_revision: project.revision,
      icon: null,
    });
    expect((await read()).status).toBe(404);
  } finally {
    authentication.mockRestore();
  }
});

test("project icon bytes survive database backup and restore", async () => {
  const { db, w, call, upload } = setup();
  const p = call<Project>("projects_create", { name: "Retained icon", icon: upload(redIcon) });
  const directory = mkdtempSync(join(tmpdir(), "allgather-icon-backup-"));
  try {
    const file = join(directory, "backup.zip");
    writeFileSync(file, await new Response(backupWorkspace(w)).bytes());
    const restored = join(directory, "restored");
    await restoreWorkspace(file, restored);
    const recovered = openDatabase(join(restored, "allgather.sqlite"));
    try {
      expect(new Workspace(recovered).project(p.id).icon).toEqual(p.icon);
      const bytes = recovered
        .query<{ bytes: Uint8Array }, [string]>(
          "SELECT bytes FROM project_icons WHERE project_id=?",
        )
        .get(p.id)!.bytes;
      expect(Buffer.from(bytes).toString("base64")).toBe(redIcon);
      expect(db.query("SELECT count(*) n FROM project_icons").get()).toEqual({ n: 1 });
    } finally {
      recovered.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
