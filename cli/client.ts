import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AppError, type Operation, type Scope } from "../shared/contracts.ts";
import { currentOperator, type OperatorMetadata } from "./operator.ts";
export const defaultLoginScopes = [
  "tasks:read",
  "tasks:write",
  "history:read",
  "sessions:read",
  "sessions:write",
  "transcripts:read",
  "sessions:control",
  "artifacts:read",
  "artifacts:write",
  "offline_access",
] as const satisfies readonly (Scope | "offline_access")[];
export const configDir = () =>
  process.env.ALLGATHER_CONFIG_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "allgather");
export function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}
export function privateJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
export function baseUrl(value?: string) {
  const input = (
    value ??
    process.env.ALLGATHER_URL ??
    readJson<{ url?: string }>(join(configDir(), "server.json"), {}).url ??
    `http://127.0.0.1:${process.env.ALLGATHER_PORT ?? 4390}`
  ).trim();
  if (!input) throw new Error("Supply a hostname or server URL");
  const explicitScheme = input.includes("://");
  const u = new URL(explicitScheme ? input : `https://${input}`);
  if (!explicitScheme && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    u.protocol = "http:";
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
    throw new Error("Use a server origin without credentials, path, query or fragment");
  if (
    u.protocol !== "https:" &&
    !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
  )
    throw new Error("Remote credentials require HTTPS");
  return u.origin;
}
interface OAuthCredential {
  access_token: string;
  refresh_token?: string;
  client_id: string;
  expires_at: number;
  resource: string;
}
type Credential = string | OAuthCredential;
export class Client {
  readonly url: string;
  readonly key: string;
  private credential?: OAuthCredential;
  private refreshing?: Promise<string>;
  constructor(
    url?: string,
    key?: string,
    readonly operator: OperatorMetadata = currentOperator(),
  ) {
    this.url = baseUrl(url);
    const saved = readJson<Record<string, Credential>>(join(configDir(), "credentials.json"), {});
    const prior = saved[this.url];
    this.key = key ?? process.env.ALLGATHER_TOKEN ?? (typeof prior === "string" ? prior : "");
    if (!this.key && prior && typeof prior === "object") this.credential = prior;
  }
  private saveCredential(value: Credential) {
    const path = join(configDir(), "credentials.json");
    privateJson(path, { ...readJson<Record<string, Credential>>(path, {}), [this.url]: value });
  }
  private async accessToken(): Promise<string> {
    if (this.key) return this.key;
    if (!this.credential)
      throw new AppError("login_required", "Run allgather login <hostname-or-url>", 401);
    if (this.credential.expires_at > Date.now() + 30000) return this.credential.access_token;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshToken().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private async refreshToken() {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const lock = join(configDir(), ".credentials-refresh.lock");
    let held = false;
    for (let attempt = 0; attempt < 350; attempt++) {
      try {
        writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
        held = true;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          const pid = Number(readFileSync(lock, "utf8"));
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ESRCH") {
                unlinkSync(lock);
                continue;
              }
            }
          }
        } catch {
          /* Another client may have released the lock. */
        }
        await Bun.sleep(100);
      }
    }
    if (!held)
      throw new AppError(
        "credentials_busy",
        "Another CLI process is refreshing credentials; retry shortly",
        409,
      );
    try {
      const saved = readJson<Record<string, Credential>>(join(configDir(), "credentials.json"), {})[
        this.url
      ];
      if (saved && typeof saved === "object") this.credential = saved;
      const old = this.credential!;
      if (old.expires_at > Date.now() + 30000) return old.access_token;
      if (!old.refresh_token)
        throw new AppError("login_required", "Session expired. Run allgather login again.", 401);
      const response = await fetch(this.url + "/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: old.client_id,
          refresh_token: old.refresh_token,
          resource: old.resource,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok)
        throw new AppError(
          "login_required",
          "CLI access expired or was revoked. Run allgather login again.",
          401,
        );
      const data = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };
      const credential = { ...old, ...data, expires_at: Date.now() + data.expires_in * 1000 };
      this.saveCredential(credential);
      privateJson(join(configDir(), "server.json"), { url: this.url });
      this.credential = credential;
      return credential.access_token;
    } finally {
      unlinkSync(lock);
    }
  }
  async loginOAuth(scope = defaultLoginScopes.join(" ")) {
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url"),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    let accept!: (code: string) => void, reject!: (error: Error) => void;
    const code = new Promise<string>((ok, fail) => {
      accept = ok;
      reject = fail;
    });
    const callback = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname !== "/callback" || url.searchParams.get("state") !== state)
          return new Response("Invalid authorization response", { status: 400 });
        if (url.searchParams.has("error")) {
          reject(new Error("Authorization was declined"));
          return new Response("Authorization declined.");
        }
        if (url.searchParams.get("iss") !== this.url || !url.searchParams.get("code"))
          return new Response("Invalid issuer or code", { status: 400 });
        accept(url.searchParams.get("code")!);
        return new Response("Allgather CLI connected. You can close this window.", {
          headers: { "content-type": "text/plain", "cache-control": "no-store" },
        });
      },
    });
    const timer = setTimeout(
      () => reject(new Error("Authorization timed out. Run login again.")),
      300000,
    );
    // Attach a rejection handler while registration is pending.
    void code.catch(() => {});
    try {
      const redirect = `http://127.0.0.1:${callback.port}/callback`,
        resource = this.url + "/api";
      const registered = await fetch(this.url + "/oauth/register-cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Allgather CLI",
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (!registered.ok) throw new Error("CLI registration failed");
      const client = (await registered.json()) as { client_id: string };
      const url = new URL(this.url + "/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: "code",
        scope,
        resource,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      console.error(`Open this URL to approve CLI access:\n${url}`);
      const grant = await code,
        response = await fetch(this.url + "/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: client.client_id,
            redirect_uri: redirect,
            code: grant,
            code_verifier: verifier,
            resource,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
      if (!response.ok) throw new Error("Authorization code exchange failed");
      const token = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };
      const credential = {
        ...token,
        client_id: client.client_id,
        resource,
        expires_at: Date.now() + token.expires_in * 1000,
      };
      this.saveCredential(credential);
      privateJson(join(configDir(), "server.json"), { url: this.url });
      this.credential = credential;
    } finally {
      clearTimeout(timer);
      await callback.stop(true);
    }
  }
  async request(path: string, body?: unknown) {
    const token = await this.accessToken();
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(this.url + path, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        break;
      } catch (error) {
        if (attempt)
          throw new AppError(
            "connection_failed",
            `Cannot reach ${this.url}: ${(error as Error).message}`,
            503,
          );
      }
    }
    if (!response) throw new AppError("connection_failed", "No server response", 503);
    if (!response.ok) {
      const data = (await response.json()) as {
        error?: { code?: string; message?: string; details?: unknown };
      };
      throw new AppError(
        data.error?.code ?? "request_failed",
        data.error?.message ?? `HTTP ${response.status}`,
        response.status,
        data.error?.details,
      );
    }
    return response;
  }
  async call<T = unknown>(name: Operation, input: unknown = {}): Promise<T> {
    return (
      (await (
        await this.request(`/api/operations/${name}`, {
          ...this.operator,
          ...(input as Record<string, unknown>),
        })
      ).json()) as { result: T }
    ).result;
  }
}
