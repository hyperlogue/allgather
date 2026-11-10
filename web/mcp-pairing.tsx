import { useCallback, useEffect, useState } from "react";
import {
  type PermissionMode,
  type PermissionModes,
  permissions,
  type Scope,
} from "../shared/permissions.ts";
import { noResources, type ResourceGrants } from "../shared/resource-grants.ts";
import { request } from "./api.ts";
import { Category, ResourceCategory } from "./permission-picker.tsx";
import { Button, ErrorText, useAction } from "./ui.tsx";

interface PairingRow {
  pairing_id: string;
  name: string;
  scopes: Scope[];
  state: "open" | "registration_closed" | "connected" | "expired" | "closed";
  created_at: string;
}
interface PairingOptions {
  pairings: PairingRow[];
  scopes: Scope[];
  projects: { id: string; name: string }[];
  machines: { id: string; name: string }[];
}
interface OpenedPairing {
  pairing_id: string;
  pairing_code: string;
  register_until: string;
  expires_at: string;
  mcp_url: string;
}
const stateLabels: Record<PairingRow["state"], string> = {
  open: "Waiting for the client",
  registration_closed: "Waiting for the code",
  connected: "Connected",
  expired: "Expired",
  closed: "Closed",
};
const defaults = (scopes: Scope[]): PermissionModes =>
  Object.fromEntries(
    scopes
      .filter((scope) => permissions[scope].defaultAllowed || permissions[scope].approval)
      .map((scope) => [scope, permissions[scope].approval ? "approval" : "allow"]),
  );

export function McpPairing({ changed, refresh = 0 }: { changed: () => void; refresh?: number }) {
  const [options, setOptions] = useState<PairingOptions | null>(null);
  const [name, setName] = useState("");
  const [modes, setModes] = useState<PermissionModes>({});
  const [resources, setResources] = useState<ResourceGrants>(noResources);
  const [opened, setOpened] = useState<OpenedPairing | null>(null);
  const [now, setNow] = useState(Date.now());
  const { busy, error, run } = useAction();
  const load = useCallback(async () => {
    const value = await request<PairingOptions>("/api/mcp/pairings");
    setOptions(value);
    return value;
  }, []);
  useEffect(() => {
    void run(async () => {
      const value = await load();
      setModes(defaults(value.scopes));
    });
  }, [load, run]);
  useEffect(() => {
    if (refresh > 0)
      void run(async () => {
        await load();
      });
  }, [refresh, load, run]);
  useEffect(() => {
    if (!opened) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void load().then((value) => {
        if (
          value.pairings.find((row) => row.pairing_id === opened.pairing_id)?.state === "connected"
        )
          changed();
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [opened, load, changed]);
  const selected = new Set(Object.keys(modes) as Scope[]);
  const categories = new Map<string, Scope[]>();
  for (const scope of options?.scopes ?? []) {
    const category = permissions[scope].category;
    categories.set(category, [...(categories.get(category) ?? []), scope]);
  }
  const change = (scopes: Scope[], mode: PermissionMode | "deny") =>
    setModes((previous) => {
      const next = { ...previous };
      for (const scope of scopes)
        if (
          mode === "deny" ||
          (mode === "approval" &&
            !permissions[scope].approval &&
            !permissions[scope].defaultAllowed)
        )
          delete next[scope];
        else
          next[scope] = mode === "approval" && permissions[scope].approval ? "approval" : "allow";
      return next;
    });
  const current = opened
    ? options?.pairings.find((row) => row.pairing_id === opened.pairing_id)
    : undefined;
  const seconds = (until: string) => Math.max(0, Math.ceil((Date.parse(until) - now) / 1000));
  return (
    <section className="history-section mcp-pairing">
      <h2>Pair an MCP client</h2>
      <p>
        Choose the name and access here. New clients can register only during the minute after you
        open pairing.
      </p>
      <ErrorText>{error}</ErrorText>
      {options && (
        <>
          <label>
            Connection name
            <input
              maxLength={160}
              placeholder="ChatGPT"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="permission-tree">
            {[...categories].map(([label, scopes]) => (
              <Category key={label} label={label} scopes={scopes} modes={modes} change={change} />
            ))}
          </div>
          <div className="permission-tree">
            <ResourceCategory
              title="Projects"
              items={options.projects}
              selected={resources.project_ids}
              change={(project_ids) => setResources((previous) => ({ ...previous, project_ids }))}
            />
            <ResourceCategory
              title="Machines"
              items={options.machines}
              selected={resources.machine_ids}
              change={(machine_ids) => setResources((previous) => ({ ...previous, machine_ids }))}
            />
            <label className="permission-choice">
              <input
                type="checkbox"
                checked={resources.unassigned}
                onChange={(event) =>
                  setResources((previous) => ({ ...previous, unassigned: event.target.checked }))
                }
              />
              <span>Unassigned — records with no project</span>
            </label>
          </div>
          <p className="muted small">Paired clients stay signed in until you revoke them below.</p>
          <div className="actions">
            <Button
              variant="primary"
              disabled={busy || !name.trim() || selected.size === 0}
              onClick={() =>
                void run(async () => {
                  setOpened(
                    await request<OpenedPairing>("/api/mcp/pairings", {
                      name: name.trim(),
                      scopes: [...selected],
                      resource_grants: resources,
                      permission_modes: modes,
                    }),
                  );
                  setNow(Date.now());
                  await load();
                })
              }
            >
              Open pairing for 1 minute
            </Button>
          </div>
        </>
      )}
      {opened && current && (
        <div className="notice pairing-code" aria-live="polite">
          {current.state === "connected" ? (
            <p>
              <strong>{current.name}</strong> is connected.
            </p>
          ) : current.state === "open" || current.state === "registration_closed" ? (
            <>
              <p>
                Add <code>{opened.mcp_url}</code> in the client
                {current.state === "open"
                  ? ` within ${seconds(opened.register_until)} seconds`
                  : " (registration closed)"}
                . On the AllGather page it opens, enter:
              </p>
              <p>
                <strong className="approval-value">{opened.pairing_code}</strong>
              </p>
              <p className="muted small">
                The code works once and expires in {seconds(opened.expires_at)} seconds. Enter it
                only on a page at {new URL(opened.mcp_url).host}.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await request(`/api/mcp/pairings/${opened.pairing_id}/revoke`, {});
                    await load();
                  })
                }
              >
                Close pairing
              </button>
            </>
          ) : (
            <p>This pairing is {stateLabels[current.state].toLowerCase()}. Open a new one.</p>
          )}
        </div>
      )}
      {!!options?.pairings.length && (
        <ul className="plain-list">
          {options.pairings.slice(0, 5).map((row) => (
            <li key={row.pairing_id}>
              <span>
                <strong>{row.name}</strong>
                <small>
                  {stateLabels[row.state]} · {new Date(row.created_at).toLocaleString()}
                </small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
