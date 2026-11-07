import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../server/auth.ts";
import { openDatabase } from "../server/storage.ts";

test("client audience is assigned by the endpoint and cannot be supplied in client metadata", () => {
  const db = openDatabase(":memory:");
  const auth = new Auth(db, "https://owner.example", "https://mcp.example");
  try {
    const input = {
      client_name: "Allgather CLI",
      redirect_uris: ["https://connector.example/callback"],
      audience: "api",
      scope: "admin",
      trusted: true,
    };
    expect(() => auth.register(input, "mcp")).toThrow("Open MCP pairing");
    db.query(
      "INSERT INTO mcp_pairings(id,code_hash,name,scopes,resources,permissions,owner,created_at,register_until,expires_at) VALUES('pairing-test','hash','Owner-chosen name','[]','{}','{}','owner','2000-01-01','2099-01-01','2099-01-01')",
    ).run();
    const external = auth.register(input, "mcp", { id: "pairing-test", name: "Owner-chosen name" });
    expect(external.client_name).toBe("Owner-chosen name");
    const local = auth.register(input, "api");
    const params = (client: string, resource: string, scope: string) => ({
      client_id: client,
      resource,
      scope,
      redirect_uri: input.redirect_uris[0],
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update("a".repeat(43)).digest("base64url"),
    });
    expect(() =>
      auth.authorizeInfo(params(external.client_id, auth.resource, "tasks:read")),
    ).toThrow("MCP pairing");
    expect(() => auth.authorizeInfo(params(external.client_id, auth.apiResource, "admin"))).toThrow(
      "not registered",
    );
    expect(auth.authorizeInfo(params(local.client_id, auth.apiResource, "admin")).audience).toBe(
      "api",
    );
    expect(() => auth.authorizeInfo(params(local.client_id, auth.resource, "tasks:read"))).toThrow(
      "not registered",
    );
    expect(auth.metadata("public").registration_endpoint).toBe(
      "https://mcp.example/oauth/register",
    );
    expect(auth.metadata("public").authorization_endpoint).toBe(
      "https://mcp.example/oauth/authorize",
    );
    expect(auth.metadata("private").registration_endpoint).toBe(
      "https://owner.example/oauth/register-cli",
    );
  } finally {
    db.close();
  }
});

test("upgrading unknown client registrations revokes grants instead of inferring private trust", () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-client-upgrade-")),
    path = join(root, "data.sqlite");
  let db = openDatabase(path);
  try {
    const auth = new Auth(db, "https://owner.example");
    const old = auth.register(
      { client_name: "Allgather CLI", redirect_uris: ["https://connector.example/callback"] },
      "api",
    );
    db.query(
      "INSERT INTO oauth_tokens(hash,client_id,scopes,expires,refresh_expires,resource) VALUES('old',?,'[\"admin\"]','2099-01-01','2099-01-01',?)",
    ).run(old.client_id, auth.apiResource);
    db.exec(
      "DROP TABLE oauth_requests; ALTER TABLE oauth_clients DROP COLUMN pairing_id; DROP TABLE mcp_pairings; DROP TRIGGER session_events_immutable; UPDATE session_events SET payload_hash=(SELECT payload FROM session_event_content WHERE id=session_events.id); ALTER TABLE session_events RENAME COLUMN payload_hash TO payload; CREATE TRIGGER session_events_immutable BEFORE UPDATE ON session_events BEGIN SELECT RAISE(ABORT,'Session events are append-only'); END; DROP TABLE session_event_content; DROP TRIGGER session_asset_retired; DROP TRIGGER session_asset_no_revival; DROP TABLE session_asset_identity; DROP TABLE transcript_deletions; DROP TRIGGER artifact_context_cleanup; DROP TRIGGER artifact_thread_context_cleanup; CREATE TRIGGER artifact_context_cleanup BEFORE DELETE ON artifacts BEGIN SELECT 1; END; CREATE TRIGGER artifact_thread_context_cleanup BEFORE DELETE ON threads BEGIN SELECT 1; END; DROP TRIGGER entity_tombstone_immutable; DROP TRIGGER artifact_comment_context_cleanup; DROP TRIGGER artifact_lifecycle_comment_context_cleanup; DROP TRIGGER artifact_version_context_cleanup; ALTER TABLE entities DROP COLUMN deleted_at; ALTER TABLE entities DROP COLUMN label; ALTER TABLE task_blockers DROP COLUMN resolved_comment_id; DROP TABLE tower_invitations; DROP TABLE approval_requests; ALTER TABLE oauth_tokens DROP COLUMN grant_id; DROP TABLE oauth_grants; ALTER TABLE agent_sessions DROP COLUMN project_id; ALTER TABLE oauth_clients DROP COLUMN audience; PRAGMA user_version=21",
    );
    db.close();
    db = openDatabase(path);
    expect(new Auth(db, auth.baseUrl).client(old.client_id)).toBeNull();
    expect(
      db.query("SELECT audience,revoked FROM oauth_clients WHERE id=?").get(old.client_id),
    ).toEqual({ audience: "mcp", revoked: 1 });
    expect(db.query("SELECT revoked FROM oauth_tokens WHERE hash='old'").get()).toEqual({
      revoked: 1,
    });
    db.close();
    db = new Database(path);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
