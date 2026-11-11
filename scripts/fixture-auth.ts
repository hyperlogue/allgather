import { createHash, randomBytes } from "node:crypto";
import { controlRequest } from "../server/control.ts";
import type { PermissionModes } from "../shared/permissions.ts";
import type { ResourceGrants } from "../shared/resource-grants.ts";
import type { MachineScope } from "../shared/tower-acp.ts";
import { fixtureRegisterPasskey } from "./fixture-passkey.ts";

export const fixtureResources = { project_ids: "*", machine_ids: "*", unassigned: true } as const;

export async function fixtureLoginLink(directory: string) {
  const response = await controlRequest(directory, "auth/login", { label: "Verification browser" });
  return ((await response.json()) as { url: string }).url;
}
export async function fixtureLogin(directory: string, origin: string) {
  const url = await fixtureLoginLink(directory);
  if (new URL(url).origin !== origin) throw new Error("Fixture login origin differs from server");
  return fixtureRegisterPasskey(url);
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
  const pairing = await request(
    "/api/cli/pairings",
    {
      name: "Verification API client",
      scopes: scopes.filter((scope) => scope !== "offline_access"),
      resource_grants: resources,
      permission_modes: modes,
    },
    true,
  );
  const tokens = await request("/api/cli/pairings/claim", {
    pairing_code: pairing.pairing_code,
    request_id: randomBytes(32).toString("base64url"),
  });
  const confirmed = await send(
    new Request(`${origin}/api/cli/pairings/${pairing.pairing_id}/confirm`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  if (!confirmed.ok) throw new Error(`Fixture pairing confirmation: ${confirmed.status}`);
  return tokens.access_token as string;
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
  const headers = { authorization: `Bearer ${enrollment.confirmation_token}` },
    path = `/api/tower/enrollments/${enrollment.enrollment_id}`;
  const key = enrollment;
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

export async function fixtureMcpAuthorization(
  ownerOrigin: string,
  cookie: string,
  options: {
    scopes: string[];
    resources?: ResourceGrants;
    modes?: PermissionModes;
    name?: string;
    mcpOrigin?: string;
    redirectUri?: string;
    state?: string;
    sendOwner?: (request: Request) => Response | Promise<Response>;
    sendMcp?: (request: Request) => Response | Promise<Response>;
  },
) {
  const mcpOrigin = options.mcpOrigin ?? ownerOrigin,
    sendOwner = options.sendOwner ?? fetch,
    sendMcp = options.sendMcp ?? sendOwner,
    redirectUri = options.redirectUri ?? "https://client.example/callback";
  const opened = await sendOwner(
    new Request(ownerOrigin + "/api/mcp/pairings", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ownerOrigin },
      body: JSON.stringify({
        name: options.name ?? "Approved test agent",
        scopes: options.scopes.filter((scope) => scope !== "offline_access"),
        resource_grants: options.resources ?? fixtureResources,
        permission_modes: options.modes ?? {},
      }),
    }),
  );
  if (opened.status !== 201)
    throw new Error(`Fixture MCP pairing: ${opened.status} ${await opened.text()}`);
  const pairing = (await opened.json()) as { pairing_code: string; pairing_id: string };
  const registered = await sendMcp(
    new Request(mcpOrigin + "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  if (registered.status !== 201)
    throw new Error(`Fixture MCP registration: ${registered.status} ${await registered.text()}`);
  const client = (await registered.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const params: Record<string, string> = {
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    resource: `${mcpOrigin}/mcp`,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    ...(options.state ? { state: options.state } : {}),
  };
  const page = await sendMcp(
    new Request(`${mcpOrigin}/oauth/authorize?${new URLSearchParams(params)}`),
  );
  const html = await page.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  if (page.status !== 200 || !requestId)
    throw new Error(`Fixture MCP authorize page: ${page.status} ${html}`);
  const submitted = await sendMcp(
    new Request(mcpOrigin + "/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: mcpOrigin },
      body: new URLSearchParams({ request_id: requestId, pairing_code: pairing.pairing_code }),
      redirect: "manual",
    }),
  );
  const location = submitted.headers.get("location");
  if (submitted.status !== 303 || !location)
    throw new Error(`Fixture MCP pairing code: ${submitted.status} ${await submitted.text()}`);
  const redirect = new URL(location);
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("Fixture MCP authorization code missing");
  return { client, params, verifier, code, redirect, pairing };
}

export async function fixtureMcpToken(
  ownerOrigin: string,
  cookie: string,
  options: Parameters<typeof fixtureMcpAuthorization>[2],
) {
  const grant = await fixtureMcpAuthorization(ownerOrigin, cookie, options);
  const mcpOrigin = options.mcpOrigin ?? ownerOrigin,
    send = options.sendMcp ?? options.sendOwner ?? fetch;
  const response = await send(
    new Request(mcpOrigin + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: grant.client.client_id,
        redirect_uri: grant.params.redirect_uri,
        code: grant.code,
        code_verifier: grant.verifier,
        resource: grant.params.resource,
      }),
    }),
  );
  if (!response.ok) throw new Error(`Fixture MCP token exchange: ${response.status}`);
  return {
    ...grant,
    tokens: (await response.json()) as { access_token: string; refresh_token?: string },
  };
}
