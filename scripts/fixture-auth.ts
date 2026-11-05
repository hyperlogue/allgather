import { createHash, randomBytes } from "node:crypto";
import { controlRequest } from "../server/control.ts";
import type { PermissionModes } from "../shared/permissions.ts";
import type { ResourceGrants } from "../shared/resource-grants.ts";
import type { MachineScope } from "../shared/tower-acp.ts";

export const fixtureResources = { project_ids: "*", machine_ids: "*", unassigned: true } as const;

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
  resources: ResourceGrants = fixtureResources,
  modes: PermissionModes = {},
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
    resource_grants: JSON.stringify(resources),
    permission_modes: JSON.stringify(modes),
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

export async function fixtureTowerEnrollment(
  origin: string,
  cookie: string,
  scopes: MachineScope[],
  name: string,
  send: (request: Request) => Response | Promise<Response> = fetch,
) {
  const post = async (path: string, body: unknown, headers: Record<string, string>) => {
    const response = await send(
      new Request(origin + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) throw new Error(`Fixture pairing failed: ${path} ${response.status}`);
    return response.json();
  };
  const invite = await post(
    "/api/tower/invitations",
    { node_label: name, scopes },
    { cookie, origin },
  );
  const hostId = randomBytes(16).toString("hex");
  const enrollment = await post(
    "/api/tower/enrollments",
    {
      pairing_code: invite.pairing_code,
      request_id: randomBytes(32).toString("base64url"),
      host_id: hostId,
      tower_version: "fixture",
      requested_scopes: scopes,
    },
    {},
  );
  const headers = { authorization: `Bearer ${enrollment.polling_token}` },
    path = `/api/tower/enrollments/${enrollment.enrollment_id}`;
  const key = await post(`${path}/poll`, {}, headers);
  await post(
    `${path}/confirm`,
    {
      credential_id: key.credential_id,
      access_key_hash: createHash("sha256").update(key.access_key).digest("hex"),
    },
    headers,
  );
  return {
    host_id: hostId,
    id: key.credential_id as string,
    machine_id: key.machine_id as string,
    access_key: key.access_key as string,
  };
}
