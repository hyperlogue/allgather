import type { Database } from "bun:sqlite";
import { z } from "zod";
import { visibleApprovalText } from "../shared/approval-content.ts";
import { AppError, type Principal, scopes } from "../shared/contracts.ts";
import { type Auth, hash, isBrowserOwner, secret } from "./auth.ts";

const pairingSecret = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const claimInput = z.object({ pairing_code: pairingSecret, request_id: pairingSecret }).strict();
interface Pairing {
  id: string;
  code_hash: string;
  name: string;
  scopes: string;
  resources: string;
  permissions: string;
  created_at: string;
  expires_at: string;
  request_hash: string | null;
  client_id: string | null;
  claimed_at: string | null;
  confirmed_at: string | null;
  revoked_at: string | null;
}

export class CliPairings {
  constructor(
    private db: Database,
    private auth: Auth,
  ) {}
  private owner(owner: Principal) {
    if (!isBrowserOwner(this.db, owner))
      throw new AppError("forbidden", "Create CLI pairing codes in the owner browser", 403);
  }
  open(input: unknown, owner: Principal) {
    this.owner(owner);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new AppError("invalid_input", "Choose the connection name and access");
    const body = input as Record<string, unknown>;
    const grant = this.auth.grantChoice("api", {
      name: body.name,
      scopes: body.scopes,
      resources: body.resource_grants,
      permission_modes: body.permission_modes,
      keep_access: true,
    });
    if (!visibleApprovalText(grant.name))
      throw new AppError("invalid_operator_name", "Use visible characters in the name");
    const now = new Date().toISOString();
    const count = this.db
      .query(
        "SELECT COUNT(*) n FROM cli_pairings WHERE confirmed_at IS NULL AND revoked_at IS NULL AND expires_at>?",
      )
      .get(now) as { n: number };
    if (count.n >= 100)
      throw new AppError(
        "pairing_capacity",
        "Cancel an unused CLI pairing code before creating another",
        429,
      );
    const id = `cli-pairing-${secret()}`,
      code = secret();
    const expires = new Date(Date.now() + 600000).toISOString();
    this.db
      .query(
        "INSERT INTO cli_pairings(id,code_hash,name,scopes,resources,permissions,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        hash(code),
        grant.name,
        JSON.stringify(grant.scopes),
        JSON.stringify(grant.resources),
        JSON.stringify(grant.permission_modes),
        now,
        expires,
      );
    return {
      pairing_id: id,
      pairing_code: code,
      expires_at: expires,
      server_url: this.auth.baseUrl,
    };
  }
  list(owner: Principal) {
    this.owner(owner);
    const now = new Date().toISOString();
    const rows = this.db
      .query(
        "SELECT * FROM cli_pairings p WHERE NOT EXISTS(SELECT 1 FROM oauth_clients c WHERE c.id=p.client_id AND c.deleted_at IS NOT NULL) ORDER BY created_at DESC,id DESC LIMIT 100",
      )
      .all() as Pairing[];
    return {
      pairings: rows.map((p) => ({
        pairing_id: p.id,
        name: p.name,
        scopes: JSON.parse(p.scopes),
        client_id: p.client_id,
        created_at: p.created_at,
        expires_at: p.expires_at,
        state:
          p.revoked_at || (p.client_id && !this.auth.client(p.client_id))
            ? "closed"
            : p.confirmed_at
              ? "connected"
              : p.expires_at <= now
                ? "expired"
                : p.client_id
                  ? "claimed"
                  : "open",
      })),
      scopes,
      projects: this.db.query("SELECT id,name FROM projects ORDER BY name,id").all(),
      machines: this.db.query("SELECT id,name FROM machines ORDER BY name,id").all(),
    };
  }
  revoke(id: string, owner: Principal) {
    this.owner(owner);
    return this.db
      .transaction(() => {
        const row = this.db
          .query("SELECT * FROM cli_pairings WHERE id=?")
          .get(id) as Pairing | null;
        if (!row) throw new AppError("not_found", "CLI pairing not found", 404);
        if (row.confirmed_at)
          throw new AppError(
            "pairing_complete",
            "Revoke the connected client in Registered clients",
            409,
          );
        this.db
          .query("UPDATE cli_pairings SET revoked_at=? WHERE id=?")
          .run(new Date().toISOString(), id);
        if (row.client_id) this.auth.revoke(row.client_id);
        return { revoked: true };
      })
      .immediate();
  }
  claim(input: unknown) {
    const parsed = claimInput.safeParse(input);
    if (!parsed.success) throw new AppError("invalid_input", "Enter a valid CLI pairing code");
    const { pairing_code: code, request_id: request } = parsed.data;
    return this.db
      .transaction(() => {
        const row = this.db
          .query("SELECT * FROM cli_pairings WHERE code_hash=?")
          .get(hash(code)) as Pairing | null;
        if (!row || row.revoked_at || row.expires_at <= new Date().toISOString())
          throw new AppError(
            "invalid_pairing_code",
            "Create a new CLI pairing code in the owner web app",
            401,
          );
        if (row.confirmed_at || (row.request_hash && row.request_hash !== hash(request)))
          throw new AppError(
            "pairing_conflict",
            "This code is already bound to another login",
            409,
          );
        const access = hash(`Allgather CLI access v1\0${row.id}\0${code}\0${request}`);
        const refresh = hash(`Allgather CLI refresh v1\0${row.id}\0${code}\0${request}`);
        if (!row.client_id) {
          row.client_id = `client-${secret()}`;
          row.claimed_at = new Date().toISOString();
          const grantId = `grant-${secret()}`;
          this.db
            .query(
              "INSERT INTO oauth_clients(id,name,redirects,method,created_at,audience) VALUES(?,?,'[]','none',?,'api')",
            )
            .run(row.client_id, row.name, row.claimed_at);
          const grantedScopes = JSON.stringify([...JSON.parse(row.scopes), "offline_access"]);
          this.db
            .query(
              "INSERT INTO oauth_grants(id,client_id,resource,scopes,resources,created_at,permissions) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              grantId,
              row.client_id,
              this.auth.apiResource,
              grantedScopes,
              row.resources,
              row.claimed_at,
              row.permissions,
            );
          this.db
            .query(
              "INSERT INTO oauth_tokens(hash,refresh_hash,client_id,scopes,expires,refresh_expires,resource,operator_name,grant_id) VALUES(?,?,?,?,?,?,?,?,?)",
            )
            .run(
              hash(access),
              hash(refresh),
              row.client_id,
              grantedScopes,
              new Date(Date.parse(row.claimed_at) + 3600000).toISOString(),
              new Date(Date.parse(row.claimed_at) + 30 * 86400000).toISOString(),
              this.auth.apiResource,
              row.name,
              grantId,
            );
          this.db
            .query("UPDATE cli_pairings SET client_id=?,request_hash=?,claimed_at=? WHERE id=?")
            .run(row.client_id, hash(request), row.claimed_at, row.id);
        }
        if (
          !this.auth.client(row.client_id) ||
          !this.db
            .query(
              "SELECT 1 FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.hash=? AND t.revoked=0 AND g.revoked=0",
            )
            .get(hash(access))
        )
          throw new AppError(
            "invalid_pairing_code",
            "This CLI connection was revoked or already rotated",
            401,
          );
        return {
          pairing_id: row.id,
          client_id: row.client_id,
          resource: this.auth.apiResource,
          access_token: access,
          refresh_token: refresh,
          expires_at: Date.parse(row.claimed_at!) + 3600000,
        };
      })
      .immediate();
  }
  confirm(id: string, token: string) {
    return this.db
      .transaction(() => {
        const row = this.db
          .query("SELECT * FROM cli_pairings WHERE id=?")
          .get(id) as Pairing | null;
        const principal = this.auth.principal(
          new Request(this.auth.baseUrl, { headers: { authorization: `Bearer ${token}` } }),
        );
        if (
          !row ||
          !principal ||
          principal.id !== row.client_id ||
          row.revoked_at ||
          (!row.confirmed_at && row.expires_at <= new Date().toISOString())
        )
          throw new AppError(
            "unauthorized",
            "Save the paired CLI credential before confirming",
            401,
          );
        this.db
          .query("UPDATE cli_pairings SET confirmed_at=COALESCE(confirmed_at,?) WHERE id=?")
          .run(new Date().toISOString(), id);
        return { state: "connected" };
      })
      .immediate();
  }
}
