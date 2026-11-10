import { useEffect, useState } from "react";
import type {
  ClientAccessOptions,
  ClientGrant,
  RegisteredClient,
} from "../shared/client-access.ts";
import {
  type PermissionMode,
  type PermissionModes,
  permissions,
  type Scope,
} from "../shared/permissions.ts";
import { request } from "./api.ts";
import { CopyId } from "./copy-id.tsx";
import { Category, ResourceCategory } from "./permission-picker.tsx";
import { Banner, Button, Dialog, ErrorText, useAction } from "./ui.tsx";

export function ClientGrants({
  client,
  close,
  saved,
}: {
  client: RegisteredClient;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const active = client.grants.filter((g) => !g.revoked);
  return (
    <Dialog title={`Access for ${client.name}`} close={close}>
      <p>
        {client.audience === "mcp" ? "MCP connector" : "CLI / API client"} ·{" "}
        <CopyId value={client.id} />
      </p>
      {message && <p role="status">{message}</p>}
      {active.length ? (
        active.map((g) => (
          <GrantEditor
            key={g.id + g.revision}
            client={client}
            grant={g}
            saved={async () => {
              await saved();
              setMessage("Access saved");
            }}
            reload={saved}
          />
        ))
      ) : (
        <p>No active authorization. Connect this client again to grant access.</p>
      )}
      {!!client.grants.filter((g) => g.revoked).length && (
        <details>
          <summary>Previous authorizations</summary>
          {client.grants
            .filter((g) => g.revoked)
            .map((g) => (
              <p key={g.id}>
                {new Date(g.created_at).toLocaleString()} · Revoked ·{" "}
                {g.scopes.map((s) => permissions[s]?.label ?? s).join(", ")}
              </p>
            ))}
        </details>
      )}
    </Dialog>
  );
}
function GrantEditor({
  client,
  grant,
  saved,
  reload,
}: {
  client: RegisteredClient;
  grant: ClientGrant;
  saved: () => Promise<void>;
  reload: () => Promise<void>;
}) {
  const [options, setOptions] = useState<ClientAccessOptions | null>(null);
  const [modes, setModes] = useState<PermissionModes>(
    Object.fromEntries(grant.scopes.map((s) => [s, grant.permission_modes[s] ?? "allow"])),
  );
  const [resources, setResources] = useState(grant.resource_grants);
  const { busy, error, run } = useAction();
  const path = `/api/clients/${encodeURIComponent(client.id)}/grants/${encodeURIComponent(grant.id)}`;
  useEffect(() => {
    void run(async () => {
      setOptions(await request<ClientAccessOptions>(path));
    });
  }, [path, run]);
  const categories = new Map<string, Scope[]>();
  for (const scope of options?.scopes ?? []) {
    const label = permissions[scope].category;
    categories.set(label, [...(categories.get(label) ?? []), scope]);
  }
  const change = (scopes: Scope[], mode: PermissionMode | "deny") =>
    setModes((old) => {
      const next = { ...old };
      for (const scope of scopes) {
        if (
          mode === "deny" ||
          (mode === "approval" &&
            !permissions[scope].approval &&
            !permissions[scope].defaultAllowed)
        )
          delete next[scope];
        else
          next[scope] = mode === "approval" && permissions[scope].approval ? "approval" : "allow";
      }
      return next;
    });
  return (
    <form
      className="client-grant-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await request(path, {
            expected_revision: grant.revision,
            scopes: Object.keys(modes),
            permission_modes: modes,
            resource_grants: resources,
          });
          await saved();
        });
      }}
    >
      <p className="muted small">
        Authorized {new Date(grant.created_at).toLocaleString()} · {grant.resource}
      </p>
      <p>
        Changes apply to future requests and queued work. Permissions outside the original
        authorization require reconnecting this client.
      </p>
      {options && (
        <>
          <div className="permission-tree">
            {[...categories].map(([label, scopes]) => (
              <Category key={label} label={label} scopes={scopes} modes={modes} change={change} />
            ))}
          </div>
          {modes.admin && (
            <Banner>
              Administrative access includes all operations. Remove it to restrict this client to
              individual permissions.
            </Banner>
          )}
          <div className="permission-tree">
            <ResourceCategory
              title="Projects"
              items={options.projects}
              selected={resources.project_ids}
              change={(project_ids) => setResources((r) => ({ ...r, project_ids }))}
            />
            <ResourceCategory
              title="Machines"
              items={options.machines}
              selected={resources.machine_ids}
              change={(machine_ids) => setResources((r) => ({ ...r, machine_ids }))}
            />
            <label className="permission-choice">
              <input
                type="checkbox"
                checked={resources.unassigned}
                onChange={(e) => setResources((r) => ({ ...r, unassigned: e.target.checked }))}
              />
              <span>Unassigned — records with no project</span>
            </label>
          </div>
        </>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await reload();
              setModes(
                Object.fromEntries(
                  grant.scopes.map((s) => [s, grant.permission_modes[s] ?? "allow"]),
                ),
              );
              setResources(grant.resource_grants);
            })
          }
        >
          Reload
        </button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !options || client.revoked !== 0 || Object.keys(modes).length === 0}
        >
          Save access
        </Button>
      </div>
      {!Object.keys(modes).length && (
        <p className="muted">Select a permission, or revoke the client to remove all access.</p>
      )}
    </form>
  );
}
