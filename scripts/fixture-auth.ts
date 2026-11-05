import { createHash, randomBytes } from "node:crypto";
import { controlRequest } from "../server/control.ts";

export async function fixtureLoginToken(directory: string) {
  const response = await controlRequest(directory, "auth/create-token", {
    label: "Verification browser",
  });
  return ((await response.json()) as { token: string }).token;
}
export async function fixtureLogin(directory: string, origin: string) {
  const response = await fetch(origin + "/api/login", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ key: await fixtureLoginToken(directory) }),
  });
  if (!response.ok) throw new Error(`Fixture login failed: ${response.status}`);
  await response.arrayBuffer();
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Fixture login did not set a cookie");
  return cookie;
}
export async function fixtureApiToken(
  origin: string,
  cookie: string,
  scopes: string[] = ["admin"],
  send: (request: Request) => Response | Promise<Response> = fetch,
) {
  const request = async (path: string, body: unknown, owner = false) => {
    const response = await send(
      new Request(origin + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(owner ? { cookie, origin } : {}) },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok)
      throw new Error(`Fixture authorization ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const client = await request("/oauth/register-cli", {
    client_name: "Verification API client",
    redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none",
  });
  const verifier = randomBytes(32).toString("base64url");
  const params = {
    client_id: client.client_id,
    redirect_uri: "https://client.example/callback",
    response_type: "code",
    resource: origin + "/api",
    scope: scopes.join(" "),
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
  const approved = await request("/api/oauth/authorize", params, true);
  const code = new URL(approved.redirect_uri).searchParams.get("code");
  if (!code) throw new Error("Fixture authorization code missing");
  const response = await send(
    new Request(origin + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: params.redirect_uri,
        code,
        code_verifier: verifier,
        resource: params.resource,
      }),
    }),
  );
  if (!response.ok) throw new Error(`Fixture token exchange: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}
