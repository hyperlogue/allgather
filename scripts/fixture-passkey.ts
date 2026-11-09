import type { Database } from "bun:sqlite";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { browserIdleMs } from "../server/browser-auth.ts";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest();
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");
export function syntheticPasskey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const id = randomBytes(32);
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
  let userHandle = "",
    counter = 0;
  return {
    id: b64(id),
    publicKey: cose,
    register(
      options: PublicKeyCredentialCreationOptionsJSON,
      origin: string,
      verified = true,
    ): RegistrationResponseJSON {
      userHandle = options.user.id;
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const authData = Buffer.concat([
        digest(options.rp.id!),
        Buffer.from([verified ? 0x45 : 0x41]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        length,
        id,
        cose,
      ]);
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        clientExtensionResults: { credProps: { rk: true } },
        response: {
          clientDataJSON: b64(
            Buffer.from(
              JSON.stringify({
                type: "webauthn.create",
                challenge: options.challenge,
                origin,
                crossOrigin: false,
              }),
            ),
          ),
          attestationObject: b64(
            isoCBOR.encode(
              new Map<string, string | Uint8Array | Map<string, string>>([
                ["fmt", "none"],
                ["authData", authData],
                ["attStmt", new Map()],
              ]),
            ),
          ),
          transports: ["internal"],
        },
      };
    },
    authenticate(
      options: PublicKeyCredentialRequestOptionsJSON,
      origin: string,
      verified = true,
    ): AuthenticationResponseJSON {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(++counter);
      const authData = Buffer.concat([
        digest(options.rpId!),
        Buffer.from([verified ? 0x05 : 0x01]),
        count,
      ]);
      const clientData = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: options.challenge,
          origin,
          crossOrigin: false,
        }),
      );
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          authenticatorData: b64(authData),
          clientDataJSON: b64(clientData),
          signature: b64(sign("sha256", Buffer.concat([authData, digest(clientData)]), privateKey)),
          userHandle,
        },
      };
    },
  };
}
export function fixtureBrowserCookie(db: Database) {
  const passkey = syntheticPasskey(),
    token = randomBytes(32).toString("base64url"),
    now = new Date().toISOString();
  db.query(
    "INSERT INTO passkeys(id,public_key,counter,user_handle,label,transports,device_type,backed_up,created_at,last_used_at) VALUES(?,?,0,?,'Synthetic browser','[]','singleDevice',0,?,?)",
  ).run(passkey.id, passkey.publicKey, randomBytes(32).toString("base64url"), now, now);
  db.query("INSERT INTO sessions(hash,expires,passkey_id,last_used_at) VALUES(?,?,?,?)").run(
    digest(token).toString("hex"),
    new Date(Date.now() + browserIdleMs).toISOString(),
    passkey.id,
    now,
  );
  return `allgather_session=${token}`;
}
export async function fixtureRegisterPasskey(
  url: string,
  send: (request: Request) => Response | Promise<Response> = fetch,
) {
  const link = new URL(url),
    token = new URLSearchParams(link.hash.slice(1)).get("key");
  const post = (path: string, body: unknown, cookie?: string) =>
    send(
      new Request(link.origin + path, {
        method: "POST",
        headers: {
          origin: link.origin,
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const start = await post("/api/passkeys/register/options", { token });
  if (!start.ok) throw new Error(`Fixture registration options failed: ${start.status}`);
  const credential = syntheticPasskey();
  const response = credential.register(await start.json(), link.origin);
  const finish = await post(
    "/api/passkeys/register/verify",
    { response },
    start.headers.get("set-cookie")!.split(";")[0],
  );
  if (!finish.ok)
    throw new Error(`Fixture passkey registration failed: ${finish.status} ${await finish.text()}`);
  return finish.headers.get("set-cookie")!.split(";")[0];
}
