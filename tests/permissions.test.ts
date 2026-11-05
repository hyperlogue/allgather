import { expect, test } from "bun:test";
import { fixtureResources } from "../scripts/fixture-auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import type { Operation, Principal } from "../shared/contracts.ts";
import { mcpOperationScopes } from "../shared/mcp-surface.ts";
import { permissions } from "../shared/permissions.ts";

test("a launch grant cannot prompt, stop, resume or answer native agent permission requests", () => {
  const db = openDatabase(":memory:"),
    w = new Workspace(db);
  const principal: Principal = {
    id: "launch-only",
    kind: "client",
    resources: fixtureResources,
    inlet: "api",
    scopes: ["sessions:launch"],
  };
  try {
    for (const name of [
      "session_prompt",
      "session_cancel",
      "session_resume",
      "session_reply",
      "session_configure",
      "session_reconcile",
    ] as Operation[])
      expect(() => w.execute(name, {}, principal)).toThrow("Scope sessions:");
    expect(w.all("SELECT * FROM session_commands")).toHaveLength(0);
    expect(w.all("SELECT * FROM session_runtimes")).toHaveLength(0);
  } finally {
    db.close();
  }
});

test("artifact contribution, project writes and repository settings do not share broad write grants", () => {
  const db = openDatabase(":memory:"),
    w = new Workspace(db);
  const principal: Principal = {
    id: "contributor",
    kind: "client",
    resources: fixtureResources,
    inlet: "api",
    scopes: ["artifacts:contribute", "tasks:write", "commits:read"],
  };
  try {
    for (const name of [
      "artifacts_delete",
      "artifacts_archive",
      "artifacts_restore",
      "artifact_threads_delete",
      "projects_create",
      "projects_update",
      "repositories_create",
      "repositories_update",
    ] as Operation[])
      expect(() => w.execute(name, {}, principal)).toThrow("Scope ");
    for (const scope of [
      "admin",
      "artifacts:manage",
      "artifacts:notify",
      "sessions:reply",
      "sessions:configure",
      "sessions:reconcile",
      "repositories:write",
      "repositories:sync",
    ])
      expect(mcpOperationScopes).not.toContain(scope);
    expect(permissions["sessions:read"].defaultAllowed).toBe(true);
    expect(permissions["transcripts:read"].defaultAllowed).toBe(true);
    expect(permissions["artifacts:read"].defaultAllowed).toBe(true);
    expect(permissions["sessions:launch"].defaultAllowed).toBe(false);
  } finally {
    db.close();
  }
});
