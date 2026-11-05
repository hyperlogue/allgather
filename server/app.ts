import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { AppError, can, operationName, VERSION } from "../shared/contracts.ts";
import { machineScopes } from "../shared/tower-acp.ts";
import { artifactApi } from "./artifact-api.ts";
import type { Auth } from "./auth.ts";
import { mcpResponse } from "./mcp.ts";
import { isPublicRoute } from "./network.ts";
import { RateLimits } from "./rate-limits.ts";
import { TowerEnrollment } from "./tower-enrollment.ts";
import type { Workspace } from "./workspace.ts";

export class Updates {
  private listeners = new Set<() => void>();
  emit() {
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
export function createApp(
  workspace: Workspace,
  auth: Auth,
  updates: Updates,
  options: {
    assets?: (r: Request) => Response | Promise<Response>;
    backup?: () => ReadableStream<Uint8Array>;
    hostname?: string;
    peer?: (r: Request) => string;
    surface?: "private" | "public";
  } = {},
) {
  const app = new Hono();
  const enrollment = new TowerEnrollment(workspace, auth.baseUrl);
  const surface = options.surface ?? "private";
  const originUrl = surface === "public" ? auth.mcpBaseUrl : auth.baseUrl;
  const allowedHosts = new Set([new URL(originUrl).host, options.hostname].filter(Boolean));
  const rates = new RateLimits();
  app.use("*", async (c, next) => {
    if (surface === "public" && !isPublicRoute(c.req.raw)) return c.text("Not found", 404);
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!allowedHosts.has(host)) throw new AppError("forbidden_host", "Host is not allowed", 403);
    const origin = c.req.header("origin");
    if (origin && origin !== originUrl)
      throw new AppError("forbidden_origin", "Origin is not allowed", 403);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.header("cookie") &&
      !origin &&
      !c.req.header("authorization")
    )
      throw new AppError("origin_required", "Cookie mutations need the application origin", 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    );
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("*", async (c, next) => {
    const publication =
      c.req.path === "/api/operations/artifacts_publish" ||
      (/^\/api\/artifacts\/[^/]+\/versions$/.test(c.req.path) && c.req.method === "POST");
    if (publication) {
      const p = auth.principal(c.req.raw);
      if (!p || !can(p, "artifacts:contribute"))
        throw new AppError("forbidden", "Artifact write access required", 403);
    }
    const small =
      c.req.path.startsWith("/oauth/") ||
      c.req.path === "/api/login" ||
      c.req.path.startsWith("/api/tower/enrollments") ||
      (c.req.path === "/mcp" && !auth.principal(c.req.raw, true));
    return bodyLimit({
      maxSize: small ? 16 * 1024 : (publication ? 192 : 32) * 1024 * 1024,
      onError: (c) =>
        c.json({ error: { code: "too_large", message: "Request exceeds the upload limit" } }, 413),
    })(c, next);
  });
  const rate = (key: string, maximum: number) => rates.take(key, maximum);
  app.onError((error, c) => {
    if (error instanceof AppError) {
      if (error.code === "slow_down") c.header("Retry-After", "5");
      if (error.code === "rate_limited")
        c.header("Retry-After", String((error.details as { retry_after: number }).retry_after));
      return c.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        error.status as 400,
      );
    }
    if (error instanceof SyntaxError)
      return c.json({ error: { code: "invalid_json", message: "Invalid request body" } }, 400);
    const oauth = error as Error & { code?: number; name?: string };
    if (typeof oauth.code === "number" && oauth.code >= 400 && oauth.code < 500)
      return c.json({ error: oauth.name, error_description: oauth.message }, oauth.code as 400);
    console.error("Request failed", error.name, error.message);
    return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
  });
  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(auth.metadata(surface)));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(auth.resourceMetadata()));
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(auth.resourceMetadata()));
  app.post("/api/login", async (c) => {
    rate(`login:${options.peer?.(c.req.raw) ?? "local"}`, 12);
    const body = await c.req.json();
    if (!body || typeof body.key !== "string" || body.key.length > 512)
      throw new AppError("invalid_input", "Enter a login code");
    c.header("Set-Cookie", auth.signIn(body.key));
    return c.json({ ok: true });
  });
  app.post("/api/tower/assets", async (c) => {
    const authorization = c.req.header("authorization"),
      token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "",
      credential = workspace.executions.authenticate(token);
    if (!credential) throw new AppError("unauthorized", "Machine authentication required", 401);
    const b = await c.req.json();
    if (
      typeof b.runtime_id !== "string" ||
      typeof b.generation !== "string" ||
      typeof b.data !== "string" ||
      typeof b.media_type !== "string" ||
      b.data.length > 28000000 ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(b.media_type) ||
      (b.name !== undefined && (typeof b.name !== "string" || b.name.length > 300))
    )
      throw new AppError("invalid_asset", "Invalid session asset");
    const r = workspace.one<{ id: string; session_id: string; protocol: string }>(
      "SELECT id,session_id,protocol FROM session_runtimes WHERE id=? AND machine_id=? AND generation=?",
      b.runtime_id,
      credential.machine_id,
      b.generation,
    );
    if (!r || !workspace.blobs)
      throw new AppError("forbidden", "Asset execution is not owned by this machine", 403);
    if (r.protocol === "terminal")
      throw new AppError("unsupported_control", "Terminal output and assets stay on Tower", 409);
    const bytes = Buffer.from(b.data, "base64");
    if (bytes.length > 20 * 1024 * 1024 || bytes.toString("base64") !== b.data)
      throw new AppError("invalid_asset", "Use canonical base64 for an asset up to 20 MiB");
    const asset = await workspace.blobs.publishing(async () => {
      const blob = await workspace.blobs!.put(bytes);
      return workspace.db
        .transaction(() => {
          if (!workspace.executions.authenticate(token))
            throw new AppError("unauthorized", "Machine access revoked", 401);
          const source = workspace.executions.source(
            r.session_id,
            r.id,
            "acp_stream",
            b.generation,
            "tower-session.v1",
            "unknown",
          );
          return workspace.executions.attachAsset(
            r.session_id,
            source,
            blob,
            b.media_type,
            b.name ?? null,
          );
        })
        .immediate();
    });
    return c.json(asset);
  });
  app.post("/api/tower/enrollments", async (c) => {
    rate(`enroll:${options.peer?.(c.req.raw) ?? "local"}`, 10);
    return c.json(enrollment.create(await c.req.json()), 201);
  });
  const pollingToken = (r: Request) => {
    const authorization = r.headers.get("authorization");
    return authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  };
  app.post("/api/tower/enrollments/:id/poll", (c) =>
    c.json(enrollment.poll(c.req.param("id"), pollingToken(c.req.raw))),
  );
  app.post("/api/tower/enrollments/:id/confirm", async (c) =>
    c.json(enrollment.confirm(c.req.param("id"), pollingToken(c.req.raw), await c.req.json())),
  );
  const browserOwner = (r: Request) => {
    const p = auth.principal(r);
    if (!p || p.inlet !== "browser" || p.kind !== "owner")
      throw new AppError("forbidden", "Sign in as the owner in this browser", 403);
    return p;
  };
  app.get("/api/tower/enrollments/:id", (c) => {
    browserOwner(c.req.raw);
    return c.json(enrollment.info(c.req.param("id")));
  });
  app.post("/api/tower/enrollments/:id/decision", async (c) => {
    const p = browserOwner(c.req.raw);
    const result = enrollment.decide(c.req.param("id"), await c.req.json(), p);
    workspace.onChange();
    return c.json(result);
  });
  app.get("/api/tower/assets/:id", async (c) => {
    const authorization = c.req.header("authorization"),
      credential = workspace.executions.authenticate(
        authorization?.startsWith("Bearer ") ? authorization.slice(7) : "",
      );
    if (!credential) throw new AppError("unauthorized", "Machine authentication required", 401);
    const runtimeId = c.req.query("runtime_id"),
      generation = c.req.query("generation");
    if (!runtimeId || !generation)
      throw new AppError("runtime_required", "Asset reads require runtime_id and generation");
    const asset = workspace.one<{ blob_hash: string; media_type: string }>(
      "SELECT a.* FROM session_assets a JOIN session_runtimes r ON r.session_id=a.session_id LEFT JOIN transcript_sources s ON s.id=a.source_id WHERE a.id=? AND r.machine_id=? AND r.id=? AND r.generation=? AND r.fenced=0 AND r.state NOT IN ('ended','error') AND (a.source_id IS NULL OR (s.runtime_id=r.id AND s.source_key=r.generation))",
      c.req.param("id"),
      credential.machine_id,
      runtimeId,
      generation,
    );
    if (!asset || !workspace.blobs)
      throw new AppError("not_found", "Asset not available to this execution", 404);
    return new Response(new Uint8Array(await workspace.blobs.read(asset.blob_hash)), {
      headers: {
        "content-type": asset.media_type,
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
      },
    });
  });
  app.get("/api/tower/credentials", (c) => {
    const p = auth.principal(c.req.raw);
    if (!p || !can(p, "admin"))
      throw new AppError("forbidden", "Administration access required", 403);
    return c.json(
      workspace.all(
        "SELECT id,machine_id,label,created_at,revoked_at FROM tower_credentials ORDER BY created_at DESC",
      ),
    );
  });
  app.post("/api/tower/credentials", async (c) => {
    const p = auth.principal(c.req.raw);
    if (!p || !can(p, "admin"))
      throw new AppError("forbidden", "Administration access required", 403);
    const body = await c.req.json();
    if (
      typeof body.machine_id !== "string" ||
      typeof body.label !== "string" ||
      body.label.length > 160
    )
      throw new AppError("invalid_input", "Provide machine_id and a label");
    const scopes = machineScopes.safeParse(body.scopes ?? ["read", "send"]);
    if (!scopes.success)
      throw new AppError(
        "invalid_scope",
        "Choose read, send, or explicit acp:control/terminal:control",
      );
    return c.json(workspace.executions.issueCredential(body.machine_id, body.label, scopes.data));
  });
  app.post("/api/tower/credentials/:id/revoke", (c) => {
    const p = auth.principal(c.req.raw);
    if (!p || !can(p, "admin"))
      throw new AppError("forbidden", "Administration access required", 403);
    workspace.executions.revokeCredential(c.req.param("id"));
    workspace.onChange();
    return c.json({ revoked: true });
  });
  app.get("/api/login-tokens", (c) => {
    browserOwner(c.req.raw);
    return c.json(auth.loginTokens());
  });
  app.post("/api/login-tokens", async (c) => {
    browserOwner(c.req.raw);
    const body = await c.req.json();
    return c.json(
      auth.createLoginToken(typeof body.label === "string" ? body.label : "Browser login"),
    );
  });
  app.post("/api/login-tokens/:id/revoke", (c) => {
    browserOwner(c.req.raw);
    auth.revokeLoginToken(c.req.param("id"));
    return c.json({ revoked: true });
  });
  app.post("/api/logout", (c) => {
    auth.signOut(c.req.raw);
    workspace.artifacts?.previews.close();
    c.header("Set-Cookie", "allgather_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return c.json({ ok: true });
  });
  app.get("/api/boot", (c) => {
    const p = auth.principal(c.req.raw);
    return c.json({ needsAuth: !p, token: null, loginRequired: true }, p ? 200 : 401);
  });
  app.get("/api/session", (c) =>
    c.json({
      authenticated: !!auth.principal(c.req.raw),
      version: VERSION,
      owner_url: auth.baseUrl,
      mcp_url: auth.resource,
    }),
  );
  app.post("/api/operations/:operation", async (c) => {
    const principal = auth.principal(c.req.raw);
    if (!principal)
      throw new AppError("unauthorized", "Sign in or supply a valid CLI credential", 401);
    rate(`api:${principal.id}`, 600);
    return c.json({
      result: await workspace.dispatch(
        operationName(c.req.param("operation")),
        await c.req.json(),
        principal,
      ),
    });
  });
  app.get("/api/session-assets/:id", async (c) => {
    const p = auth.principal(c.req.raw);
    if (!p || !can(p, "transcripts:read"))
      throw new AppError("forbidden", "Transcript read access required", 403);
    const asset = workspace.one<{ blob_hash: string; media_type: string; name: string | null }>(
      "SELECT * FROM session_assets WHERE id=?",
      c.req.param("id"),
    );
    if (!asset || !workspace.blobs) throw new AppError("not_found", "Asset not found", 404);
    const bytes = await workspace.blobs.read(asset.blob_hash);
    const inline =
      /^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|wav|ogg|webm)|video\/(mp4|webm))$/.test(
        asset.media_type,
      );
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": asset.media_type,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(asset.name ?? "session-asset")}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=3600",
      },
    });
  });
  app.get("/api/events", (c) => {
    if (!auth.principal(c.req.raw)) throw new AppError("unauthorized", "Sign in first", 401);
    return streamSSE(c, async (stream) => {
      let wake: () => void = () => {},
        done = false;
      const unsubscribe = updates.subscribe(() => wake());
      stream.onAbort(() => {
        done = true;
        wake();
      });
      try {
        await stream.writeSSE({ event: "ready", data: "{}" });
        while (!done) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 15000);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          if (done) break;
          if (!auth.principal(c.req.raw)) break;
          await stream.writeSSE({ event: "change", data: "{}" });
        }
      } finally {
        unsubscribe();
      }
    });
  });
  app.post("/oauth/register", async (c) => {
    rate(`register:${options.peer?.(c.req.raw) ?? "local"}`, 10);
    return c.json(auth.register(await c.req.json()), 201);
  });
  app.post("/oauth/register-cli", async (c) => {
    rate(`register:${options.peer?.(c.req.raw) ?? "local"}`, 10);
    return c.json(auth.register(await c.req.json(), "api"), 201);
  });
  app.get("/api/oauth/request", (c) => {
    if (!auth.principal(c.req.raw)) throw new AppError("unauthorized", "Sign in first", 401);
    return c.json(auth.authorizeInfo(c.req.query()));
  });
  app.post("/api/oauth/authorize", async (c) => {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Object.values(body).some((v) => typeof v !== "string"))
      throw new AppError("invalid_input", "Invalid authorization request");
    return c.json(await auth.authorize(c.req.raw, body));
  });
  app.post("/oauth/token", async (c) => {
    rate(`token:${options.peer?.(c.req.raw) ?? "local"}`, 60);
    const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
    if (surface === "public" && body.resource !== auth.resource)
      throw new AppError("invalid_target", "The public endpoint only issues MCP credentials");
    return c.json(await auth.exchange(c.req.raw, body));
  });
  app.post("/oauth/revoke", async (c) => {
    rate(`revoke:${options.peer?.(c.req.raw) ?? "local"}`, 60);
    const token = new URLSearchParams(await c.req.text()).get("token");
    if (token) auth.revokeToken(token);
    return c.json({});
  });
  app.get("/api/clients", (c) => {
    const p = auth.principal(c.req.raw);
    if (!p || !can(p, "admin")) throw new AppError("forbidden", "Owner access required", 403);
    return c.json(auth.clients());
  });
  app.post("/api/clients/:id/revoke", (c) => {
    const p = auth.principal(c.req.raw);
    if (!p || !can(p, "admin")) throw new AppError("forbidden", "Owner access required", 403);
    auth.revoke(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/api/backup", async (c) => {
    const p = auth.principal(c.req.raw);
    if (!p || !can(p, "admin")) throw new AppError("forbidden", "Owner access required", 403);
    if (!options.backup) throw new AppError("unavailable", "Backup is unavailable", 503);
    return new Response(options.backup(), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": "attachment; filename=allgather-backup.zip",
      },
    });
  });
  app.all("/mcp", async (c) => {
    const principal = auth.principal(c.req.raw, true);
    if (!principal) {
      c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${auth.mcpBaseUrl}/.well-known/oauth-protected-resource/mcp"`,
      );
      return c.json({ error: "unauthorized" }, 401);
    }
    rate(`mcp:${principal.id}`, 300);
    return mcpResponse(c.req.raw, workspace, principal);
  });
  app.route("/", artifactApi(workspace, auth));
  app.get("/artifact-workspace/:id", (c) => {
    if (!auth.principal(c.req.raw)) throw new AppError("unauthorized", "Sign in to Allgather", 401);
    c.header("X-Frame-Options", "SAMEORIGIN");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'",
    );
    return options.assets?.(c.req.raw) ?? c.text("Not found", 404);
  });
  app.all("*", (c) => options.assets?.(c.req.raw) ?? new Response("Not found", { status: 404 }));
  return app;
}
