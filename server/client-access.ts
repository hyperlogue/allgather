import type { Database } from "bun:sqlite";
import { z } from "zod";
import type {
  ClientAccessOptions,
  ClientGrant,
  RegisteredClient,
} from "../shared/client-access.ts";
import { AppError, type Principal, type Scope, scopes } from "../shared/contracts.ts";
import { mcpOperationScopes } from "../shared/mcp-surface.ts";
import { type Auth, hash, isBrowserOwner } from "./auth.ts";

interface GrantRow {
  id: string;
  client_id: string;
  resource: string;
  scopes: string;
  resources: string;
  permissions: string;
  created_at: string;
  revoked: number;
}
const inputSchema = z
  .object({
    expected_revision: z.string().length(64),
    scopes: z.array(z.string()).max(scopes.length),
    permission_modes: z.record(z.string(), z.enum(["allow", "approval"])),
    resource_grants: z.unknown(),
  })
  .strict();
const revision = (g: GrantRow) =>
  hash(JSON.stringify([g.id, g.scopes, g.resources, g.permissions, g.revoked]));

export class ClientAccess {
  constructor(
    private db: Database,
    private auth: Auth,
  ) {}
  private owner(p: Principal | null) {
    if (!p || !isBrowserOwner(this.db, p))
      throw new AppError("forbidden", "Use the owner browser to manage client grants", 403);
  }
  private grant(client: string, id: string) {
    const row = this.db
      .query("SELECT * FROM oauth_grants WHERE id=? AND client_id=?")
      .get(id, client) as GrantRow | null;
    if (!row) throw new AppError("not_found", "Client grant not found", 404);
    return row;
  }
  private present(g: GrantRow): ClientGrant {
    return {
      id: g.id,
      resource: g.resource,
      scopes: JSON.parse(g.scopes).filter((s: string) => s !== "offline_access"),
      permission_modes: JSON.parse(g.permissions),
      resource_grants: JSON.parse(g.resources),
      created_at: g.created_at,
      revoked: !!g.revoked,
      revision: revision(g),
    };
  }
  list(): RegisteredClient[] {
    return (
      this.db
        .query(
          "SELECT c.id,c.name,c.audience,c.created_at,c.revoked,a.last_used_at FROM oauth_clients c LEFT JOIN client_activity a ON a.client_id=c.id WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC,c.id",
        )
        .all() as Omit<RegisteredClient, "grants">[]
    ).map((c) => ({
      ...c,
      grants: (
        this.db
          .query("SELECT * FROM oauth_grants WHERE client_id=? ORDER BY created_at DESC,id")
          .all(c.id) as GrantRow[]
      ).map((g) => this.present(g)),
    }));
  }
  remove(id: string, p: Principal | null) {
    this.owner(p);
    return this.db
      .transaction(() => {
        const client = this.db
          .query("SELECT revoked,deleted_at FROM oauth_clients WHERE id=?")
          .get(id) as { revoked: number; deleted_at: string | null } | null;
        if (!client) throw new AppError("not_found", "Connection not found", 404);
        if (client.deleted_at) return { deleted: true };
        if (!client.revoked)
          throw new AppError("client_active", "Revoke this connection before deleting it", 409);
        this.auth.revoke(id);
        this.db
          .query("UPDATE oauth_clients SET deleted_at=? WHERE id=?")
          .run(new Date().toISOString(), id);
        return { deleted: true };
      })
      .immediate();
  }
  options(client: string, id: string, p: Principal | null): ClientAccessOptions {
    this.owner(p);
    const g = this.grant(client, id);
    const audience = (
      this.db.query("SELECT audience FROM oauth_clients WHERE id=?").get(client) as {
        audience: string;
      }
    ).audience;
    const tokens = this.db.query("SELECT scopes FROM oauth_tokens WHERE grant_id=?").all(id) as {
      scopes: string;
    }[];
    const original = new Set<string>(
      tokens.length ? tokens.flatMap((t) => JSON.parse(t.scopes)) : JSON.parse(g.scopes),
    );
    return {
      scopes: (audience === "api" ? scopes : mcpOperationScopes).filter(
        (s) => original.has(s) || original.has("admin"),
      ) as Scope[],
      projects: this.db
        .query("SELECT id,name FROM projects ORDER BY name,id")
        .all() as ClientAccessOptions["projects"],
      machines: this.db
        .query("SELECT id,name FROM machines ORDER BY name,id")
        .all() as ClientAccessOptions["machines"],
    };
  }
  update(client: string, id: string, input: unknown, p: Principal | null): ClientGrant {
    this.owner(p);
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        "invalid_input",
        "Choose permissions and resources with the current grant revision",
      );
    return this.db
      .transaction(() => {
        const g = this.grant(client, id),
          c = this.auth.client(client);
        if (!c || g.revoked)
          throw new AppError("grant_revoked", "Reconnect this client to grant access again", 409);
        if (revision(g) !== parsed.data.expected_revision)
          throw new AppError(
            "revision_conflict",
            "This grant changed. Reload it before saving",
            409,
          );
        const available = this.options(client, id, p).scopes;
        if (parsed.data.scopes.some((s) => !available.includes(s as Scope)))
          throw new AppError(
            "reauthorization_required",
            "Reconnect the client to add permissions outside its original authorization",
            409,
          );
        const selected = this.auth.grantChoice(c.audience, {
          name: c.name,
          scopes: parsed.data.scopes,
          resources: parsed.data.resource_grants,
          permission_modes: parsed.data.permission_modes,
          keep_access: true,
        });
        const saved = [
          ...selected.scopes,
          ...(JSON.parse(g.scopes).includes("offline_access") ? ["offline_access"] : []),
        ];
        this.db
          .query("UPDATE oauth_grants SET scopes=?,resources=?,permissions=? WHERE id=?")
          .run(
            JSON.stringify(saved),
            JSON.stringify(selected.resources),
            JSON.stringify(selected.permission_modes),
            id,
          );
        return this.present(this.grant(client, id));
      })
      .immediate();
  }
}

export function connectionIdentity(db: Database, id: string) {
  return db.query("SELECT id,name,deleted_at FROM oauth_clients WHERE id=?").get(id) as
    | import("../shared/client-access.ts").ConnectionIdentity
    | null;
}
