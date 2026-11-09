import type { PermissionModes, Scope } from "./permissions.ts";
import type { ResourceGrants } from "./resource-grants.ts";

export interface ClientGrant {
  id: string;
  resource: string;
  scopes: Scope[];
  permission_modes: PermissionModes;
  resource_grants: ResourceGrants;
  created_at: string;
  revoked: boolean;
  revision: string;
}
export interface RegisteredClient {
  id: string;
  name: string;
  audience: "api" | "mcp";
  created_at: string;
  revoked: number;
  last_used_at: string | null;
  grants: ClientGrant[];
}
export interface ClientAccessOptions {
  scopes: Scope[];
  projects: { id: string; name: string }[];
  machines: { id: string; name: string }[];
}

export interface ConnectionIdentity {
  id: string;
  name: string;
  deleted_at: string | null;
}
export function connectionActorLabel(
  connection: ConnectionIdentity | null | undefined,
  original: string,
) {
  return connection?.deleted_at
    ? `Deleted account (previously known as ${connection.name})`
    : original;
}
