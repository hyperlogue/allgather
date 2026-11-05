import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import OAuth2Server from "@node-oauth/oauth2-server";
import { AppError, type Principal, type Scope, scopes } from "../shared/contracts.ts";
import { mcpOperationScopes } from "../shared/mcp-surface.ts";
import { type PermissionModes, permissions } from "../shared/permissions.ts";
import { resourceGrantsSchema } from "../shared/resource-grants.ts";

export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const mcpScopes = [...mcpOperationScopes, "offline_access"];
const apiScopes = [...scopes, "offline_access"];
export const OWNER: Principal = { id: "owner", kind: "owner", scopes: ["admin"] };
interface ClientRow {
  audience: "mcp" | "api";
  id: string;
  name: string;
  redirects: string;
  secret_hash: string | null;
  method: string;
  created_at: string;
  revoked: number;
}
interface TokenRow {
  grant_id: string;
  resources: string;
  granted_scopes: string;
  permissions: string;
  hash: string;
  refresh_hash: string;
  client_id: string;
  scopes: string;
  expires: string;
  refresh_expires: string;
  resource: string;
  revoked: number;
  operator_name: string | null;
}
export class Auth {
  private readonly oauth: OAuth2Server;
  readonly resource: string;
  readonly apiResource: string;
  constructor(
    private db: Database,
    readonly baseUrl: string,
    readonly mcpBaseUrl = baseUrl,
  ) {
    this.resource = `${mcpBaseUrl}/mcp`;
    this.apiResource = `${baseUrl}/api`;
    this.oauth = new OAuth2Server({
      authorizationCodeLifetime: 120,
      accessTokenLifetime: 3600,
      refreshTokenLifetime: 30 * 86400,
      requireClientAuthentication: { authorization_code: false, refresh_token: false },
      model: {
        getClient: async (id: string, clientSecret?: string) => {
          const c = this.client(id);
          if (!c) return false;
          if (clientSecret && (!c.secret_hash || !equal(c.secret_hash, hash(clientSecret))))
            return false;
          return {
            id: c.id,
            grants: ["authorization_code", "refresh_token"],
            redirectUris: JSON.parse(c.redirects),
          };
        },
        validateScope: async (
          _user: OAuth2Server.User,
          _client: OAuth2Server.Client,
          scope?: string[],
        ) => {
          if (!this.allowedResource(_client.id, _user.resource)) return false;
          const selected = scope?.length ? scope : ["tasks:read"];
          return selected.every((s) =>
            (_user.resource === this.apiResource ? apiScopes : mcpScopes).includes(s),
          )
            ? selected
            : false;
        },
        saveAuthorizationCode: async (
          code: Pick<
            OAuth2Server.AuthorizationCode,
            | "authorizationCode"
            | "codeChallenge"
            | "codeChallengeMethod"
            | "expiresAt"
            | "redirectUri"
            | "scope"
          >,
          client: OAuth2Server.Client,
          user: OAuth2Server.User,
        ) => {
          const { authorizationCode, ...rest } = code;
          db.transaction(() => {
            db.query("UPDATE oauth_grants SET revoked=1 WHERE client_id=? AND resource=?").run(
              client.id,
              String(user.resource),
            );
            db.query("UPDATE oauth_tokens SET revoked=1 WHERE client_id=? AND resource=?").run(
              client.id,
              String(user.resource),
            );
            db.query(
              "DELETE FROM oauth_codes WHERE json_extract(data,'$.client.id')=? AND json_extract(data,'$.resource')=?",
            ).run(client.id, String(user.resource));
            db.query(
              "INSERT INTO oauth_grants(id,client_id,resource,scopes,resources,created_at,permissions) VALUES(?,?,?,?,?,?,?)",
            ).run(
              String(user.grant_id),
              client.id,
              String(user.resource),
              JSON.stringify(code.scope),
              JSON.stringify(user.resources),
              new Date().toISOString(),
              JSON.stringify(user.permission_modes),
            );
            db.query("INSERT INTO oauth_codes VALUES(?,?,?)").run(
              hash(authorizationCode),
              JSON.stringify({ ...rest, client, user, resource: user.resource }),
              code.expiresAt.toISOString(),
            );
          }).immediate();
          return { ...code, client, user };
        },
        getAuthorizationCode: async (value: string) => {
          const r = db
            .query("SELECT data,expires FROM oauth_codes WHERE hash=?")
            .get(hash(value)) as { data: string; expires: string } | null;
          if (!r) return false;
          const data = JSON.parse(r.data);
          if (!this.allowedResource(data.client.id, data.resource)) return false;
          return { ...data, authorizationCode: value, expiresAt: new Date(r.expires) };
        },
        revokeAuthorizationCode: async (code: OAuth2Server.AuthorizationCode) =>
          db.query("DELETE FROM oauth_codes WHERE hash=?").run(hash(code.authorizationCode))
            .changes === 1,
        saveToken: async (
          token: OAuth2Server.Token,
          client: OAuth2Server.Client,
          user: OAuth2Server.User,
        ) => {
          if (
            !this.allowedResource(client.id, user.resource) ||
            !db
              .query(
                "SELECT 1 FROM oauth_grants WHERE id=? AND client_id=? AND resource=? AND revoked=0",
              )
              .get(String(user.grant_id), client.id, String(user.resource))
          )
            throw new AppError("revoked_client", "Client access was revoked", 401);
          if (!token.accessTokenExpiresAt || !token.refreshTokenExpiresAt || !token.refreshToken)
            throw new Error("OAuth library returned an incomplete token record");
          const offline = token.scope?.includes("offline_access");
          db.query(
            "INSERT INTO oauth_tokens(hash,refresh_hash,client_id,scopes,expires,refresh_expires,resource,revoked,operator_name,grant_id) VALUES(?,?,?,?,?,?,?,0,?,?)",
          ).run(
            hash(token.accessToken),
            offline ? hash(token.refreshToken) : null,
            client.id,
            JSON.stringify(token.scope),
            token.accessTokenExpiresAt.toISOString(),
            token.refreshTokenExpiresAt.toISOString(),
            String(user.resource),
            String(user.operator_name ?? this.client(client.id)?.name ?? "MCP client").slice(
              0,
              160,
            ),
            String(user.grant_id),
          );
          return {
            ...token,
            refreshToken: offline ? token.refreshToken : undefined,
            refreshTokenExpiresAt: offline ? token.refreshTokenExpiresAt : undefined,
            client,
            user,
          };
        },
        getAccessToken: async (value: string) => {
          const row = this.tokenRow(value);
          if (!row) return false;
          return {
            accessToken: value,
            accessTokenExpiresAt: new Date(row.expires),
            scope: JSON.parse(row.scopes),
            client: { id: row.client_id, grants: ["authorization_code", "refresh_token"] },
            user: {
              id: "owner",
              operator_name: row.operator_name,
              resource: row.resource,
              grant_id: row.grant_id,
            },
          };
        },
        getRefreshToken: async (value: string) => {
          const row = db
            .query(
              "SELECT t.*,g.resources,g.scopes granted_scopes,g.permissions FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id AND g.revoked=0 WHERE t.refresh_hash=? AND t.revoked=0",
            )
            .get(hash(value)) as TokenRow | null;
          if (!row || !this.allowedResource(row.client_id, row.resource)) return false;
          return {
            refreshToken: value,
            refreshTokenExpiresAt: new Date(row.refresh_expires),
            scope: JSON.parse(row.scopes),
            client: { id: row.client_id, grants: ["authorization_code", "refresh_token"] },
            user: {
              id: "owner",
              operator_name: row.operator_name,
              resource: row.resource,
              grant_id: row.grant_id,
            },
          };
        },
        revokeToken: async (token: OAuth2Server.RefreshToken) =>
          db
            .query("UPDATE oauth_tokens SET revoked=1 WHERE refresh_hash=? AND revoked=0")
            .run(hash(token.refreshToken)).changes === 1,
      },
    });
  }
  client(id: unknown) {
    if (typeof id !== "string" || !id) return null;
    return this.db
      .query(`SELECT * FROM oauth_clients c WHERE id=? AND revoked=0 AND (
        created_at>? OR EXISTS(SELECT 1 FROM oauth_tokens t WHERE t.client_id=c.id)
        OR EXISTS(SELECT 1 FROM oauth_codes a WHERE json_extract(a.data,'$.client.id')=c.id AND a.expires>?)
      )`)
      .get(
        id,
        new Date(Date.now() - 15 * 60000).toISOString(),
        new Date().toISOString(),
      ) as ClientRow | null;
  }
  private allowedResource(clientId: string, resource: unknown) {
    const client = this.client(clientId);
    return !!client && resource === (client.audience === "api" ? this.apiResource : this.resource);
  }
  private tokenRow(value: string) {
    const r = this.db
      .query(
        "SELECT t.*,g.resources,g.scopes granted_scopes,g.permissions FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id AND g.revoked=0 WHERE t.hash=? AND t.revoked=0",
      )
      .get(hash(value)) as TokenRow | null;
    return r && this.allowedResource(r.client_id, r.resource) ? r : null;
  }
  principal(request: Request, mcp = false): Principal | null {
    const authorization = request.headers.get("authorization");
    if (authorization) {
      if (!authorization.startsWith("Bearer ")) return null;
      const token = authorization.slice(7);
      const row = this.tokenRow(token);
      if (
        row &&
        row.resource === (mcp ? this.resource : this.apiResource) &&
        Date.parse(row.expires) > Date.now()
      )
        return {
          id: row.client_id,
          kind: "client",
          grant_id: row.grant_id,
          resources: resourceGrantsSchema.parse(JSON.parse(row.resources)),
          permission_modes: JSON.parse(row.permissions),
          inlet: mcp ? "mcp" : "api",
          operator_name: row.operator_name ?? this.client(row.client_id)?.name ?? "MCP client",
          scopes: (JSON.parse(row.scopes) as string[]).filter(
            (s) => s !== "offline_access" && JSON.parse(row.granted_scopes).includes(s),
          ) as Scope[],
          auth_binding: { kind: "oauth", hash: hash(token) },
        };
      return null;
    }
    if (mcp) return null;
    const cookie = /(?:^|;\s*)allgather_session=([^;]+)/.exec(
      request.headers.get("cookie") ?? "",
    )?.[1];
    if (cookie) {
      const now = new Date().toISOString(),
        row = this.db
          .query(
            "SELECT s.token_id,t.last_used_at,t.revoked_at FROM sessions s JOIN login_tokens t ON t.id=s.token_id WHERE s.hash=? AND s.expires>?",
          )
          .get(hash(cookie), now) as {
          token_id: string;
          last_used_at: string;
          revoked_at: string | null;
        } | null;
      if (row && !row.revoked_at && Date.parse(row.last_used_at) > Date.now() - 14 * 86400000) {
        if (Date.parse(row.last_used_at) < Date.now() - 60000)
          this.db.query("UPDATE login_tokens SET last_used_at=? WHERE id=?").run(now, row.token_id);
        return {
          ...OWNER,
          id: `browser-${hash(cookie).slice(0, 24)}`,
          inlet: "browser",
          auth_binding: { kind: "browser", hash: hash(cookie) },
        };
      }
    }
    return null;
  }
  createLoginToken(label = "Browser login") {
    if (!label.trim() || label.length > 160)
      throw new AppError("invalid_label", "Token label must have 1 to 160 characters");
    const value = secret(),
      id = `login-${secret().slice(0, 16)}`;
    const now = new Date().toISOString(),
      expires = new Date(Date.now() + 10 * 60000).toISOString();
    this.db
      .query(
        "INSERT INTO login_tokens(id,hash,label,created_at,last_used_at,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, hash(value), label.trim(), now, now, expires);
    return { id, label: label.trim(), token: value, expires_at: expires };
  }
  loginTokens() {
    return this.db
      .query(
        "SELECT id,label,created_at,last_used_at,revoked_at,expires_at,consumed_at FROM login_tokens ORDER BY created_at DESC",
      )
      .all();
  }
  revokeLoginToken(id: string) {
    this.db
      .transaction(() => {
        this.db
          .query("UPDATE login_tokens SET revoked_at=? WHERE id=?")
          .run(new Date().toISOString(), id);
        this.db.query("DELETE FROM sessions WHERE token_id=?").run(id);
      })
      .immediate();
  }
  resetAccess() {
    revokeCredentials(this.db);
  }
  signIn(token: string) {
    const value = secret(),
      now = new Date().toISOString();
    this.db
      .transaction(() => {
        const row = this.db
          .query(
            "SELECT id FROM login_tokens WHERE hash=? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?",
          )
          .get(hash(token), now) as { id: string } | null;
        if (!row)
          throw new AppError(
            "unauthorized",
            "The login code is invalid, expired, revoked, or already used",
            401,
          );
        this.db.query("DELETE FROM sessions WHERE expires<=?").run(now);
        this.db
          .query("UPDATE login_tokens SET last_used_at=?,consumed_at=? WHERE id=?")
          .run(now, now, row.id);
        this.db
          .query("INSERT INTO sessions(hash,expires,token_id) VALUES(?,?,?)")
          .run(hash(value), new Date(Date.now() + 30 * 86400000).toISOString(), row.id);
      })
      .immediate();
    return `allgather_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${this.baseUrl.startsWith("https:") ? "; Secure" : ""}`;
  }
  signOut(request: Request) {
    const c = /(?:^|;\s*)allgather_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (c) this.db.query("DELETE FROM sessions WHERE hash=?").run(hash(c));
  }
  private pruneRegistrations() {
    const now = new Date().toISOString();
    this.db.query("DELETE FROM oauth_codes WHERE expires<=?").run(now);
    const unused = `NOT EXISTS(SELECT 1 FROM oauth_tokens t WHERE t.client_id=oauth_clients.id)
      AND NOT EXISTS(SELECT 1 FROM oauth_codes a WHERE json_extract(a.data,'$.client.id')=oauth_clients.id)
      AND NOT EXISTS(SELECT 1 FROM oauth_grants g WHERE g.client_id=oauth_clients.id)`;
    this.db
      .query(`DELETE FROM oauth_clients WHERE ${unused} AND (revoked=1 OR created_at<=?)`)
      .run(new Date(Date.now() - 15 * 60000).toISOString());
    const approved = this.db
      .query(
        "SELECT COUNT(*) n FROM oauth_clients c WHERE revoked=0 AND EXISTS(SELECT 1 FROM oauth_tokens t WHERE t.client_id=c.id)",
      )
      .get() as { n: number };
    if (approved.n >= 100)
      throw new AppError("client_limit", "Revoke an unused connection before adding another", 429);
    const pending = this.db
      .query(`SELECT id FROM oauth_clients WHERE ${unused} ORDER BY created_at,id`)
      .all() as { id: string }[];
    for (const row of pending.slice(0, Math.max(0, pending.length - 255)))
      this.db.query("DELETE FROM oauth_clients WHERE id=?").run(row.id);
  }
  register(body: Record<string, unknown>, audience: "mcp" | "api" = "mcp") {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError("invalid_client_metadata", "Provide a client metadata object");
    }
    const redirects = body.redirect_uris;
    if (
      !Array.isArray(redirects) ||
      redirects.length === 0 ||
      redirects.length > 10 ||
      !redirects.every((r) => typeof r === "string" && this.validRedirect(r))
    )
      throw new AppError(
        "invalid_redirect_uri",
        "Use exact HTTPS callback URLs, or loopback HTTP for local testing",
      );
    const method = body.token_endpoint_auth_method ?? "none";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(String(method)))
      throw new AppError("invalid_client_metadata", "Unsupported token authentication method");
    if (
      body.grant_types &&
      (!Array.isArray(body.grant_types) ||
        (body.grant_types as unknown[]).some(
          (g) => !["authorization_code", "refresh_token"].includes(String(g)),
        ))
    )
      throw new AppError(
        "invalid_client_metadata",
        "Only authorization code and refresh grants are available",
      );
    if (body.response_types && JSON.stringify(body.response_types) !== '["code"]')
      throw new AppError("invalid_client_metadata", "Only code responses are available");
    this.pruneRegistrations();
    const id = `client-${secret()}`,
      clientSecret = method === "none" ? undefined : secret();
    const name =
      typeof body.client_name === "string" ? body.client_name.trim().slice(0, 120) : "MCP client";
    this.db
      .query(
        "INSERT INTO oauth_clients(id,name,redirects,secret_hash,method,created_at,revoked,audience) VALUES(?,?,?,?,?,?,0,?)",
      )
      .run(
        id,
        name,
        JSON.stringify(redirects),
        clientSecret ? hash(clientSecret) : null,
        String(method),
        new Date().toISOString(),
        audience,
      );
    return {
      client_id: id,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: clientSecret ? 0 : undefined,
      client_name: name,
      redirect_uris: redirects,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
    };
  }
  private validRedirect(value: string) {
    try {
      if (value.length > 2048) return false;
      const u = new URL(value);
      return (
        !u.username &&
        !u.password &&
        !u.hash &&
        (u.protocol === "https:" ||
          (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
      );
    } catch {
      return false;
    }
  }
  authorizeInfo(params: Record<string, string>) {
    const c = this.client(params.client_id);
    if (!c) throw new AppError("invalid_client", "Unknown or revoked OAuth client");
    if (!(JSON.parse(c.redirects) as string[]).includes(params.redirect_uri))
      throw new AppError("invalid_redirect_uri", "Callback URL is not registered");
    if (
      params.response_type !== "code" ||
      params.code_challenge_method !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge ?? "")
    )
      throw new AppError("invalid_request", "Authorization code with S256 PKCE is required");
    if (!this.allowedResource(c.id, params.resource))
      throw new AppError(
        "invalid_target",
        "This client is not registered for the requested resource",
      );
    const selected = (params.scope ?? "tasks:read").split(" ").filter(Boolean);
    if (
      !selected.every((s) =>
        (params.resource === this.apiResource ? apiScopes : mcpScopes).includes(s),
      )
    )
      throw new AppError("invalid_scope", "Requested scopes are not available");
    return {
      client_id: c.id,
      name: c.name,
      scopes: selected.filter((scope) => scope !== "offline_access"),
      redirect_uri: params.redirect_uri,
      audience: c.audience,
      resource: params.resource,
      projects: this.db.query("SELECT id,name FROM projects ORDER BY name,id").all(),
      machines: this.db.query("SELECT id,name FROM machines ORDER BY name,id").all(),
    };
  }
  async authorize(request: Request, params: Record<string, string>) {
    if (this.principal(request)?.inlet !== "browser")
      throw new AppError("unauthorized", "Sign in before granting access", 401);
    const info = this.authorizeInfo(params);
    if (params.keep_access !== undefined && !["true", "false"].includes(params.keep_access))
      throw new AppError("invalid_request", "Choose whether to keep this connection signed in");
    if (info.scopes.length === 0)
      throw new AppError("invalid_scope", "Select at least one permission");
    params = {
      ...params,
      scope: [...info.scopes, ...(params.keep_access === "false" ? [] : ["offline_access"])].join(
        " ",
      ),
    };
    const selectedResources = resourceGrantsSchema.safeParse(
      params.resource_grants ? JSON.parse(params.resource_grants) : {},
    );
    if (!selectedResources.success)
      throw new AppError("invalid_grant", "Choose project and machine access");
    const resources = selectedResources.data;
    for (const [table, ids] of [
      ["projects", resources.project_ids],
      ["machines", resources.machine_ids],
    ] as const) {
      if (
        ids !== "*" &&
        ids.some((id) => !this.db.query(`SELECT 1 FROM ${table} WHERE id=?`).get(id))
      )
        throw new AppError("invalid_grant", "A selected resource no longer exists");
    }
    const modes: PermissionModes = params.permission_modes
      ? JSON.parse(params.permission_modes)
      : {};
    if (
      !modes ||
      typeof modes !== "object" ||
      Array.isArray(modes) ||
      Object.entries(modes).some(
        ([scope, mode]) =>
          !info.scopes.includes(scope) ||
          !["allow", "approval"].includes(mode) ||
          (mode === "approval" && !permissions[scope as Scope].approval),
      )
    )
      throw new AppError(
        "invalid_grant",
        "Approval mode is only available for session launch, prompt, stop and resume",
      );
    const grantId = `grant-${secret()}`;
    const operatorName = params.operator_name?.trim() || info.name;
    if (operatorName.length > 160)
      throw new AppError("invalid_operator_name", "Operator name must have at most 160 characters");

    const response = new OAuth2Server.Response();
    await this.oauth.authorize(
      new OAuth2Server.Request({
        method: "GET",
        headers: Object.fromEntries(request.headers),
        query: params,
        body: {},
      }),
      response,
      {
        authenticateHandler: {
          handle: () => ({
            id: "owner",
            operator_name: operatorName,
            resource: params.resource,
            grant_id: grantId,
            resources,
            permission_modes: modes,
          }),
        },
        allowEmptyState: true,
      },
    );
    const location = new URL(response.headers?.location ?? "");
    location.searchParams.set(
      "iss",
      params.resource === this.resource ? this.mcpBaseUrl : this.baseUrl,
    );
    return { redirect_uri: location.toString() };
  }
  async exchange(request: Request, body: Record<string, string>) {
    if (!["authorization_code", "refresh_token"].includes(body.grant_type))
      throw new AppError("unsupported_grant_type", "Unsupported grant type");
    if (![this.resource, this.apiResource].includes(body.resource))
      throw new AppError(
        "invalid_target",
        "The resource must name this server’s MCP or API endpoint",
      );
    const stored =
      body.grant_type === "authorization_code"
        ? (this.db
            .query("SELECT data FROM oauth_codes WHERE hash=?")
            .get(hash(body.code ?? "")) as { data: string } | null)
        : (this.db
            .query("SELECT resource FROM oauth_tokens WHERE refresh_hash=? AND revoked=0")
            .get(hash(body.refresh_token ?? "")) as { resource: string } | null);
    if (stored) {
      const resource = "data" in stored ? JSON.parse(stored.data).resource : stored.resource;
      if (resource !== body.resource)
        throw new AppError("invalid_target", "This grant belongs to a different resource");
    }
    let id = body.client_id,
      clientSecret = body.client_secret;
    const basic = request.headers.get("authorization");
    if (basic?.startsWith("Basic ")) {
      const decoded = Buffer.from(basic.slice(6), "base64").toString();
      const split = decoded.indexOf(":");
      id = decodeURIComponent(decoded.slice(0, split));
      clientSecret = decodeURIComponent(decoded.slice(split + 1));
    }
    const client = this.client(id);
    if (
      !client ||
      (client.method !== "none" &&
        (!clientSecret || !client.secret_hash || !equal(client.secret_hash, hash(clientSecret))))
    )
      throw new AppError("invalid_client", "Client authentication failed", 401);
    if (client.method === "client_secret_basic" && !basic?.startsWith("Basic "))
      throw new AppError("invalid_client", "HTTP Basic client authentication is required", 401);
    if (client.method === "client_secret_post" && basic)
      throw new AppError("invalid_client", "Use client_secret_post authentication", 401);
    if (!this.allowedResource(client.id, body.resource))
      throw new AppError(
        "invalid_target",
        "This client is not registered for the requested resource",
      );
    const response = new OAuth2Server.Response();
    await this.oauth.token(
      new OAuth2Server.Request({
        method: "POST",
        headers: {
          ...Object.fromEntries(request.headers),
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(new URLSearchParams(body).toString())),
        },
        query: {},
        body,
      }),
      response,
    );
    return response.body as Record<string, unknown>;
  }
  clients() {
    return this.db
      .query(
        "SELECT id,name,redirects,method,created_at,revoked,audience FROM oauth_clients ORDER BY created_at DESC",
      )
      .all() as Omit<ClientRow, "secret_hash">[];
  }
  revoke(id: string) {
    this.db
      .transaction(() => {
        this.db.query("UPDATE oauth_clients SET revoked=1 WHERE id=?").run(id);
        this.db.query("UPDATE oauth_tokens SET revoked=1 WHERE client_id=?").run(id);
        this.db.query("UPDATE oauth_grants SET revoked=1 WHERE client_id=?").run(id);
      })
      .immediate();
  }
  revokeToken(value: string) {
    this.db
      .transaction(() => {
        this.db
          .query(
            "UPDATE oauth_grants SET revoked=1 WHERE id IN (SELECT grant_id FROM oauth_tokens WHERE hash=? OR refresh_hash=?)",
          )
          .run(hash(value), hash(value));
        this.db
          .query(
            "UPDATE oauth_tokens SET revoked=1 WHERE grant_id IN (SELECT grant_id FROM oauth_tokens WHERE hash=? OR refresh_hash=?)",
          )
          .run(hash(value), hash(value));
      })
      .immediate();
  }
  metadata(surface: "private" | "public" = "private") {
    const issuer = surface === "public" ? this.mcpBaseUrl : this.baseUrl;
    return {
      issuer,
      authorization_endpoint: `${this.baseUrl}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/${surface === "public" ? "register" : "register-cli"}`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: surface === "public" ? mcpScopes : apiScopes,
      authorization_response_iss_parameter_supported: true,
    };
  }
  resourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.mcpBaseUrl],
      scopes_supported: mcpScopes.filter((s) => s !== "offline_access"),
      bearer_methods_supported: ["header"],
    };
  }
}

export function revokeCredentials(db: Database) {
  db.transaction(() => {
    db.exec(`
      DELETE FROM settings WHERE key='owner_key_hash';
      DELETE FROM sessions;
      DELETE FROM oauth_codes;
      UPDATE login_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
      UPDATE oauth_tokens SET revoked=1;
      UPDATE oauth_clients SET revoked=1;
      UPDATE oauth_grants SET revoked=1;
      UPDATE tower_credentials SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
      UPDATE tower_enrollments SET state='denied';
      UPDATE machines SET connected=0,active_credential_id=NULL;
      UPDATE session_runtimes SET connected=0;
      UPDATE worker_registrations SET state='retired';
      UPDATE session_commands SET state='failed',result='{"code":"credentials_revoked"}' WHERE state='queued';
    `);
  }).immediate();
}
