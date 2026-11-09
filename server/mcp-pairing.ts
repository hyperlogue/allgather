import type { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { visibleApprovalText } from "../shared/approval-content.ts";
import { AppError, type Principal } from "../shared/contracts.ts";
import { type PermissionModes, permissions, type Scope } from "../shared/permissions.ts";
import { type ResourceGrants, resourceGrantsSchema } from "../shared/resource-grants.ts";
import { type Auth, hash, isBrowserOwner, secret } from "./auth.ts";

export const pairingTiming = { registerMs: 60_000, expireMs: 6 * 60_000 };
const maxRegistrations = 10,
  maxFailures = 5,
  maxRequests = 20;
const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";
const requestKeys = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "state",
  "resource",
] as const;

interface Pairing {
  id: string;
  code_hash: string;
  name: string;
  scopes: string;
  resources: string;
  permissions: string;
  created_at: string;
  register_until: string;
  expires_at: string;
  registrations: number;
  failures: number;
  consumed_at: string | null;
  client_id: string | null;
  revoked_at: string | null;
}
export interface PairingPage {
  status: number;
  title: string;
  message?: string;
  form?: {
    request_id: string;
    name: string;
    redirect_host: string;
    cancel_url: string;
    scopes: { label: string; approval: boolean }[];
    resources: string[];
  };
  redirect?: string;
}

const normalize = (code: string) => code.toUpperCase().replace(/[\s-]/g, "");
const equalHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function pairingCode() {
  const code = [...randomBytes(10)].map((byte) => alphabet[byte & 31]).join("");
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export class McpPairings {
  constructor(
    private db: Database,
    private auth: Auth,
    private clock = () => Date.now(),
  ) {}
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private owner(p: Principal) {
    if (!isBrowserOwner(this.db, p, this.now()))
      throw new AppError("forbidden", "Open MCP pairing from the owner browser", 403);
  }
  private openPairing(id: string | null | undefined) {
    if (!id) return null;
    return this.db
      .query(
        "SELECT * FROM mcp_pairings WHERE id=? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>? AND failures<?",
      )
      .get(id, this.now(), maxFailures) as Pairing | null;
  }
  open(input: unknown, owner: Principal) {
    this.owner(owner);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new AppError("invalid_input", "Choose the connection name and access", 400);
    const body = input as Record<string, unknown>;
    const grant = this.auth.grantChoice("mcp", {
      scopes: body.scopes,
      resources: body.resource_grants,
      permission_modes: body.permission_modes,
      name: body.name,
      keep_access: true,
    });
    if (!visibleApprovalText(grant.name))
      throw new AppError("invalid_operator_name", "Use visible characters in the name");
    const code = pairingCode(),
      id = `pairing-${secret().slice(0, 16)}`,
      at = this.clock(),
      registerUntil = new Date(at + pairingTiming.registerMs).toISOString(),
      expires = new Date(at + pairingTiming.expireMs).toISOString();
    this.db
      .transaction(() => {
        this.db
          .query(
            "UPDATE mcp_pairings SET revoked_at=? WHERE revoked_at IS NULL AND consumed_at IS NULL",
          )
          .run(this.now());
        this.db.query("DELETE FROM oauth_requests").run();
        this.db
          .query(
            "INSERT INTO mcp_pairings(id,code_hash,name,scopes,resources,permissions,owner,created_at,register_until,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            hash(normalize(code)),
            grant.name,
            JSON.stringify(grant.scopes),
            JSON.stringify(grant.resources),
            JSON.stringify(grant.permission_modes),
            owner.id,
            new Date(at).toISOString(),
            registerUntil,
            expires,
          );
      })
      .immediate();
    return {
      pairing_id: id,
      pairing_code: code,
      register_until: registerUntil,
      expires_at: expires,
      mcp_url: this.auth.resource,
    };
  }
  list(owner: Principal) {
    this.owner(owner);
    const now = this.now();
    return (
      this.db
        .query(
          "SELECT * FROM mcp_pairings p WHERE NOT EXISTS(SELECT 1 FROM oauth_clients c WHERE c.id=p.client_id AND c.deleted_at IS NOT NULL) ORDER BY created_at DESC,id DESC LIMIT 50",
        )
        .all() as Pairing[]
    ).map((row) => ({
      pairing_id: row.id,
      name: row.name,
      scopes: (JSON.parse(row.scopes) as string[]).filter((s) => s !== "offline_access"),
      client_id: row.client_id,
      created_at: row.created_at,
      register_until: row.register_until,
      expires_at: row.expires_at,
      state: row.consumed_at
        ? "connected"
        : row.revoked_at || row.failures >= maxFailures
          ? "closed"
          : row.expires_at <= now
            ? "expired"
            : row.register_until > now
              ? "open"
              : "registration_closed",
    }));
  }
  options(owner: Principal) {
    this.owner(owner);
    return {
      scopes: this.auth.metadata().scopes_supported.filter((s) => s !== "offline_access"),
      projects: this.db.query("SELECT id,name FROM projects ORDER BY name,id").all(),
      machines: this.db.query("SELECT id,name FROM machines ORDER BY name,id").all(),
    };
  }
  revoke(id: string, owner: Principal) {
    this.owner(owner);
    this.db
      .transaction(() => {
        this.db
          .query(
            "UPDATE mcp_pairings SET revoked_at=? WHERE id=? AND revoked_at IS NULL AND consumed_at IS NULL",
          )
          .run(this.now(), id);
        this.db.query("DELETE FROM oauth_requests WHERE pairing_id=?").run(id);
      })
      .immediate();
    return { revoked: true };
  }
  register(body: Record<string, unknown>) {
    return this.db
      .transaction(() => {
        const pairing = this.db
          .query(
            "SELECT * FROM mcp_pairings WHERE revoked_at IS NULL AND consumed_at IS NULL AND register_until>? AND failures<? ORDER BY created_at DESC LIMIT 1",
          )
          .get(this.now(), maxFailures) as Pairing | null;
        if (!pairing || pairing.registrations >= maxRegistrations)
          throw new AppError("pairing_closed", "Open MCP pairing in Allgather first", 403);
        const client = this.auth.register(body, { id: pairing.id, name: pairing.name });
        this.db
          .query("UPDATE mcp_pairings SET registrations=registrations+1 WHERE id=?")
          .run(pairing.id);
        return client;
      })
      .immediate();
  }
  private closed(message: string, status = 400): PairingPage {
    return { status, title: "Pairing unavailable", message };
  }
  private form(pairing: Pairing, requestId: string, params: Record<string, string>) {
    const scopes = (JSON.parse(pairing.scopes) as string[]).filter((s) => s !== "offline_access");
    const modes = JSON.parse(pairing.permissions) as PermissionModes;
    const resources = resourceGrantsSchema.parse(JSON.parse(pairing.resources)) as ResourceGrants;
    const cancel = new URL(params.redirect_uri);
    cancel.searchParams.set("error", "access_denied");
    if (params.state) cancel.searchParams.set("state", params.state);
    const count = (ids: "*" | string[], noun: string) =>
      ids === "*"
        ? `All ${noun}s, including new ones`
        : `${ids.length} ${noun}${ids.length === 1 ? "" : "s"}`;
    return {
      request_id: requestId,
      name: pairing.name,
      redirect_host: new URL(params.redirect_uri).host,
      cancel_url: cancel.toString(),
      scopes: scopes.map((scope) => ({
        label: permissions[scope as Scope].label,
        approval: modes[scope as Scope] === "approval",
      })),
      resources: [
        count(resources.project_ids, "project"),
        count(resources.machine_ids, "machine"),
        ...(resources.unassigned ? ["Records with no project"] : []),
      ],
    };
  }
  start(query: Record<string, string>): PairingPage {
    let client: ReturnType<Auth["authorizationClient"]>;
    try {
      client = this.auth.authorizationClient(query);
    } catch (error) {
      if (error instanceof AppError) return this.closed(error.message);
      throw error;
    }
    const pairing = this.openPairing(client.pairing_id);
    if (client.audience !== "mcp" || !pairing)
      return this.closed("Open a new MCP pairing in Allgather and connect again.", 403);
    const now = this.now();
    this.db.query("DELETE FROM oauth_requests WHERE expires_at<=?").run(now);
    const live = this.db
      .query("SELECT COUNT(*) n FROM oauth_requests WHERE pairing_id=?")
      .get(pairing.id) as { n: number };
    if (live.n >= maxRequests)
      return this.closed("Too many connection attempts. Open a new MCP pairing.", 429);
    const id = secret(),
      params = Object.fromEntries(
        requestKeys.flatMap((key) => (query[key] === undefined ? [] : [[key, query[key]]])),
      );
    this.db
      .query(
        "INSERT INTO oauth_requests(hash,client_id,pairing_id,params,expires_at) VALUES(?,?,?,?,?)",
      )
      .run(hash(id), client.id, pairing.id, JSON.stringify(params), pairing.expires_at);
    return { status: 200, title: "Connect an MCP client", form: this.form(pairing, id, params) };
  }
  async finish(request: Request, body: Record<string, string>): Promise<PairingPage> {
    const stored = this.db
      .query("SELECT * FROM oauth_requests WHERE hash=? AND expires_at>?")
      .get(hash(body.request_id ?? ""), this.now()) as {
      client_id: string;
      pairing_id: string;
      params: string;
    } | null;
    if (!stored) return this.closed("This connection attempt expired. Connect again.", 400);
    const pairing = this.openPairing(stored.pairing_id);
    const params = JSON.parse(stored.params) as Record<string, string>;
    const client = this.auth.client(stored.client_id);
    if (!pairing || !client || client.pairing_id !== pairing.id)
      return this.closed("Open a new MCP pairing in Allgather and connect again.", 403);
    if (!equalHash(hash(normalize(body.pairing_code ?? "")), pairing.code_hash)) {
      const failures = this.db
        .transaction(() => {
          const { failures } = this.db
            .query("UPDATE mcp_pairings SET failures=failures+1 WHERE id=? RETURNING failures")
            .get(pairing.id) as { failures: number };
          if (failures >= maxFailures)
            this.db.query("DELETE FROM oauth_requests WHERE pairing_id=?").run(pairing.id);
          return failures;
        })
        .immediate();
      if (failures >= maxFailures)
        return this.closed("Too many incorrect codes. This pairing is closed.", 403);
      return {
        status: 400,
        title: "Connect an MCP client",
        message: `Incorrect pairing code. ${maxFailures - failures} attempts remain.`,
        form: this.form(pairing, body.request_id, params),
      };
    }
    const consumed = this.db
      .transaction(() => {
        const changed = this.db
          .query(
            "UPDATE mcp_pairings SET consumed_at=?,client_id=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL",
          )
          .run(this.now(), client.id, pairing.id).changes;
        this.db.query("DELETE FROM oauth_requests WHERE pairing_id=?").run(pairing.id);
        return changed === 1;
      })
      .immediate();
    if (!consumed) return this.closed("This pairing was already used.", 409);
    const redirect = await this.auth.issueCode(request, params, {
      scopes: JSON.parse(pairing.scopes) as Scope[],
      resources: resourceGrantsSchema.parse(JSON.parse(pairing.resources)),
      permission_modes: JSON.parse(pairing.permissions) as PermissionModes,
      name: pairing.name,
      keep_access: true,
    });
    return { status: 303, title: "Connected", redirect };
  }
}

const htmlText = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
export function pairingHtml(page: PairingPage) {
  const form = page.form;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlText(page.title)} · allgather</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}input{background:#222;color:#eee}}
h1{font-size:1.4rem}.notice{padding:.75rem;border:1px solid #c80;border-radius:6px}.muted{opacity:.75;font-size:.9rem}
input{font:inherit;font-family:ui-monospace,monospace;letter-spacing:.1em;padding:.5rem;width:100%;box-sizing:border-box;text-transform:uppercase}
button{font:inherit;padding:.5rem 1rem;margin-top:1rem}a{margin-left:1rem}
</style></head><body><p><strong>▦ allgather</strong></p><h1>${htmlText(page.title)}</h1>${
    page.message ? `<p class="notice">${htmlText(page.message)}</p>` : ""
  }${
    form
      ? `<p>Connect <strong>${htmlText(form.name)}</strong> and return to <strong>${htmlText(form.redirect_host)}</strong>.</p>
<p class="muted">Continue only if you opened this pairing in Allgather and started this connection yourself.</p>
<p>The pairing grants:</p><ul>${form.scopes
          .map(
            (s) => `<li>${htmlText(s.label)}${s.approval ? " — requires your approval" : ""}</li>`,
          )
          .join("")}</ul><ul>${form.resources.map((r) => `<li>${htmlText(r)}</li>`).join("")}</ul>
<p class="muted">The connection stays signed in until you revoke it in Allgather.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${htmlText(form.request_id)}">
<label>Pairing code from Allgather<input name="pairing_code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required maxlength="32" autofocus></label>
<button type="submit">Connect</button><a href="${htmlText(form.cancel_url)}">Cancel</a></form>`
      : ""
  }</body></html>`;
}
