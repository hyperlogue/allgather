import type { Database } from "bun:sqlite";
import { isIP } from "node:net";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { AppError } from "../shared/contracts.ts";
import { hash, secret } from "./auth-secrets.ts";

export const browserIdleMs = 30 * 86400000;
const ceremonyMs = 5 * 60000;
const algorithms = [-7, -257];
interface Challenge {
  hash: string;
  challenge: string;
  kind: "register" | "authenticate";
  link_id: string | null;
  expires_at: string;
}
interface Passkey {
  id: string;
  public_key: Uint8Array;
  counter: number;
  user_handle: string;
  label: string;
  revoked_at: string | null;
}
function cookie(request: Request, name: string) {
  return request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((part) => part.startsWith(name + "="))
    ?.slice(name.length + 1);
}
export function activeBrowserSession(
  db: Database,
  sessionHash: string,
  now = new Date().toISOString(),
) {
  return db
    .query(
      "SELECT s.passkey_id,s.last_used_at FROM sessions s JOIN passkeys p ON p.id=s.passkey_id WHERE s.hash=? AND s.expires>? AND p.revoked_at IS NULL",
    )
    .get(sessionHash, now) as { passkey_id: string; last_used_at: string } | null;
}
export class BrowserAuth {
  readonly rpID: string;
  constructor(
    private db: Database,
    readonly origin: string,
  ) {
    this.rpID = new URL(origin).hostname;
  }
  private cookie(name: string, value: string, seconds: number, path = "/") {
    return `${name}=${value}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=${seconds}${this.origin.startsWith("https:") ? "; Secure" : ""}`;
  }
  private userHandle() {
    this.db
      .query("INSERT OR IGNORE INTO settings(key,value) VALUES('passkey_user_handle',?)")
      .run(secret());
    return (
      this.db.query("SELECT value FROM settings WHERE key='passkey_user_handle'").get() as {
        value: string;
      }
    ).value;
  }
  createLink(label = "Owner passkey") {
    if (isIP(this.rpID.replace(/^\[|\]$/g, "")))
      throw new AppError(
        "passkey_hostname_required",
        "Passkeys require a hostname. Configure ownerUrl with your HTTPS hostname, or http://localhost:PORT for local use, then restart the server.",
      );
    if (typeof label !== "string" || !label.trim() || label.length > 160)
      throw new AppError("invalid_label", "Passkey name must have 1 to 160 characters");
    const token = secret(),
      id = `login-${secret()}`;
    const now = new Date().toISOString(),
      expires = new Date(Date.now() + ceremonyMs).toISOString();
    this.db
      .query(
        "INSERT INTO login_tokens(id,hash,label,created_at,last_used_at,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, hash(token), label.trim(), now, now, expires);
    return {
      id,
      label: label.trim(),
      url: `${this.origin}/welcome#key=${token}`,
      expires_at: expires,
    };
  }
  private link(token: unknown) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new AppError(
        "invalid_login_link",
        "This login link is invalid. Run allgather-server login to create a new one.",
        401,
      );
    const row = this.db
      .query(
        "SELECT id,label,expires_at FROM login_tokens WHERE hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?",
      )
      .get(hash(token), new Date().toISOString()) as {
      id: string;
      label: string;
      expires_at: string;
    } | null;
    if (!row)
      throw new AppError(
        "invalid_login_link",
        "This login link expired or was already used. Run allgather-server login to create a new one.",
        401,
      );
    return row;
  }
  private storeChallenge(
    challenge: string,
    kind: Challenge["kind"],
    expires: string,
    linkId: string | null,
    request: Request,
  ) {
    const now = new Date().toISOString();
    this.db
      .query("DELETE FROM passkey_challenges WHERE expires_at<=? OR hash=?")
      .run(now, hash(cookie(request, "allgather_ceremony") ?? ""));
    const count = this.db.query("SELECT COUNT(*) n FROM passkey_challenges").get() as { n: number };
    if (count.n >= 5000)
      throw new AppError("ceremony_capacity", "Try signing in again in a few minutes", 429);
    const token = secret();
    this.db
      .query(
        "INSERT INTO passkey_challenges(hash,challenge,kind,link_id,expires_at) VALUES(?,?,?,?,?)",
      )
      .run(hash(token), challenge, kind, linkId, expires);
    return this.cookie(
      "allgather_ceremony",
      token,
      Math.max(1, Math.floor((Date.parse(expires) - Date.now()) / 1000)),
      "/api/passkeys",
    );
  }
  private takeChallenge(request: Request, kind: Challenge["kind"]) {
    const token = cookie(request, "allgather_ceremony");
    const row = this.db
      .query("DELETE FROM passkey_challenges WHERE hash=? RETURNING *")
      .get(hash(token ?? "")) as Challenge | null;
    if (!row || row.kind !== kind || row.expires_at <= new Date().toISOString())
      throw new AppError("expired_challenge", "This passkey request expired. Try again.", 401);
    return row;
  }
  async registrationOptions(request: Request, token: unknown) {
    const link = this.link(token);
    const options = await generateRegistrationOptions({
      rpName: "Allgather",
      rpID: this.rpID,
      userName: `Owner at ${new URL(this.origin).host}`,
      userID: Buffer.from(this.userHandle(), "base64url"),
      userDisplayName: "Allgather owner",
      attestationType: "none",
      timeout: ceremonyMs,
      supportedAlgorithmIDs: algorithms,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: this.db
        .query("SELECT id FROM passkeys WHERE revoked_at IS NULL")
        .all() as { id: string }[],
    });
    return {
      options,
      cookie: this.storeChallenge(options.challenge, "register", link.expires_at, link.id, request),
    };
  }
  async register(request: Request, response: RegistrationResponseJSON) {
    const challenge = this.takeChallenge(request, "register");
    let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      result = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        supportedAlgorithmIDs: algorithms,
      });
    } catch {
      throw new AppError(
        "invalid_passkey",
        "Passkey registration could not be verified. Try again.",
        401,
      );
    }
    if (!result.verified)
      throw new AppError("invalid_passkey", "Passkey registration could not be verified", 401);
    const info = result.registrationInfo;
    return this.db
      .transaction(() => {
        const now = new Date().toISOString();
        if (challenge.expires_at <= now)
          throw new AppError(
            "expired_challenge",
            "This login link expired. Create a new one.",
            401,
          );
        const link = this.db
          .query(
            "UPDATE login_tokens SET consumed_at=?,last_used_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>? RETURNING label",
          )
          .get(now, now, challenge.link_id, now) as { label: string } | null;
        if (!link)
          throw new AppError(
            "invalid_login_link",
            "This login link expired or was already used. Create a new one.",
            401,
          );
        if (this.db.query("SELECT 1 FROM passkeys WHERE id=?").get(info.credential.id))
          throw new AppError(
            "passkey_exists",
            "This passkey is already registered. Sign in with it.",
            409,
          );
        this.db
          .query(
            "INSERT INTO passkeys(id,public_key,counter,user_handle,label,transports,device_type,backed_up,created_at,last_used_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            info.credential.id,
            info.credential.publicKey,
            info.credential.counter,
            this.userHandle(),
            link.label,
            JSON.stringify(info.credential.transports ?? []),
            info.credentialDeviceType,
            Number(info.credentialBackedUp),
            now,
            now,
          );
        return this.newSession(info.credential.id);
      })
      .immediate();
  }
  async authenticationOptions(request: Request) {
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: "required",
      timeout: ceremonyMs,
    });
    return {
      options,
      cookie: this.storeChallenge(
        options.challenge,
        "authenticate",
        new Date(Date.now() + ceremonyMs).toISOString(),
        null,
        request,
      ),
    };
  }
  async authenticate(request: Request, response: AuthenticationResponseJSON) {
    const challenge = this.takeChallenge(request, "authenticate");
    const key =
      typeof response?.id === "string"
        ? (this.db
            .query("SELECT * FROM passkeys WHERE id=? AND revoked_at IS NULL")
            .get(response.id) as Passkey | null)
        : null;
    if (!key || response.response?.userHandle !== key.user_handle)
      throw new AppError("invalid_passkey", "This passkey could not sign in to Allgather", 401);
    let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter },
        requireUserVerification: true,
      });
    } catch {
      throw new AppError("invalid_passkey", "This passkey could not sign in to Allgather", 401);
    }
    if (!result.verified)
      throw new AppError("invalid_passkey", "This passkey could not sign in to Allgather", 401);
    return this.db
      .transaction(() => {
        const now = new Date().toISOString();
        if (
          challenge.expires_at <= now ||
          !this.db
            .query(
              "UPDATE passkeys SET counter=?,backed_up=?,last_used_at=? WHERE id=? AND counter=? AND revoked_at IS NULL",
            )
            .run(
              result.authenticationInfo.newCounter,
              Number(result.authenticationInfo.credentialBackedUp),
              now,
              key.id,
              key.counter,
            ).changes
        )
          throw new AppError(
            "invalid_passkey",
            "This passkey request is no longer valid. Try again.",
            401,
          );
        return this.newSession(key.id);
      })
      .immediate();
  }
  private newSession(passkeyId: string) {
    const token = secret(),
      now = new Date().toISOString();
    this.db.query("DELETE FROM sessions WHERE expires<=?").run(now);
    this.db
      .query("INSERT INTO sessions(hash,expires,passkey_id,last_used_at) VALUES(?,?,?,?)")
      .run(hash(token), new Date(Date.now() + browserIdleMs).toISOString(), passkeyId, now);
    return this.cookie("allgather_session", token, browserIdleMs / 1000);
  }
  session(request: Request) {
    const token = cookie(request, "allgather_session");
    return token && activeBrowserSession(this.db, hash(token)) ? hash(token) : null;
  }
  renew(request: Request) {
    if (request.headers.has("authorization")) return null;
    const token = cookie(request, "allgather_session");
    if (!token) return null;
    const row = activeBrowserSession(this.db, hash(token));
    if (!row || Date.parse(row.last_used_at) > Date.now() - 60000) return null;
    const now = new Date().toISOString();
    this.db
      .query("UPDATE sessions SET last_used_at=?,expires=? WHERE hash=?")
      .run(now, new Date(Date.now() + browserIdleMs).toISOString(), hash(token));
    this.db.query("UPDATE passkeys SET last_used_at=? WHERE id=?").run(now, row.passkey_id);
    return this.cookie("allgather_session", token, browserIdleMs / 1000);
  }
  signOut(request: Request) {
    const token = cookie(request, "allgather_session");
    if (token) this.db.query("DELETE FROM sessions WHERE hash=?").run(hash(token));
    return this.cookie("allgather_session", "", 0);
  }
  list() {
    return this.db
      .query(
        "SELECT id,label,created_at,last_used_at,revoked_at FROM passkeys ORDER BY created_at DESC,id DESC",
      )
      .all();
  }
  revoke(id: string) {
    this.db
      .transaction(() => {
        this.db
          .query("UPDATE passkeys SET revoked_at=? WHERE id=?")
          .run(new Date().toISOString(), id);
        this.db.query("DELETE FROM sessions WHERE passkey_id=?").run(id);
      })
      .immediate();
  }
}
