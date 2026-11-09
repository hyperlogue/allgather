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
import { ErrorText, useAction } from "./ui.tsx";

interface PairingRow {
  pairing_id: string;
  name: string;
  state: "open" | "claimed" | "connected" | "expired" | "closed";
}
interface Options {
  pairings: PairingRow[];
  scopes: Scope[];
  projects: { id: string; name: string }[];
  machines: { id: string; name: string }[];
}
interface Opened {
  pairing_id: string;
  pairing_code: string;
  expires_at: string;
  server_url: string;
}
export function CliPairing({ changed, refresh = 0 }: { changed: () => void; refresh?: number }) {
  const [options, setOptions] = useState<Options | null>(null);
  const [name, setName] = useState("");
  const [modes, setModes] = useState<PermissionModes>({});
  const [resources, setResources] = useState<ResourceGrants>(noResources);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [now, setNow] = useState(Date.now());
  const { busy, error, run } = useAction();
  const load = useCallback(async () => {
    const value = await request<Options>("/api/cli/pairings");
    setOptions(value);
    return value;
  }, []);
  useEffect(() => {
    void run(async () => {
      const value = await load();
      setModes(
        Object.fromEntries(
          value.scopes
            .filter((scope) => permissions[scope].defaultAllowed || permissions[scope].approval)
            .map((scope) => [scope, permissions[scope].approval ? "approval" : "allow"]),
        ),
      );
    });
  }, [load, run]);
  useEffect(() => {
    if (refresh > 0)
      void run(async () => {
        await load();
      });
  }, [refresh, load, run]);
  const current = opened
    ? options?.pairings.find((row) => row.pairing_id === opened.pairing_id)
    : undefined;
  const active =
    !!opened &&
    !!current &&
    ["open", "claimed"].includes(current.state) &&
    Date.parse(opened.expires_at) > now;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void run(async () => {
        const value = await load();
        if (
          value.pairings.some(
            (row) => row.pairing_id === opened?.pairing_id && row.state === "connected",
          )
        )
          changed();
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [active, opened, load, run, changed]);
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
  return (
    <section className="history-section cli-pairing">
      <h2>Connect CLI</h2>
      <p>
        Choose access for a CLI on any machine. Create a code here, then paste it into the CLI login
        prompt within ten minutes.
      </p>
      <ErrorText>{error}</ErrorText>
      {options && !active && (
        <>
          <label>
            CLI connection name
            <input
              maxLength={160}
              placeholder="Development CLI"
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
          <p className="muted small">
            This CLI stays signed in until you revoke it in Registered clients.
          </p>
          <button
            type="button"
            className="primary"
            disabled={busy || !name.trim() || Object.keys(modes).length === 0}
            onClick={() =>
              void run(async () => {
                setOpened(
                  await request<Opened>("/api/cli/pairings", {
                    name: name.trim(),
                    scopes: Object.keys(modes),
                    resource_grants: resources,
                    permission_modes: modes,
                  }),
                );
                setNow(Date.now());
                await load();
              })
            }
          >
            Create CLI pairing code
          </button>
        </>
      )}
      {opened && options?.pairings.some((p) => p.pairing_id === opened.pairing_id) && (
        <div className="notice cli-pairing-code" aria-live="polite">
          {active ? (
            <>
              <p>Run this command on the target machine:</p>
              <pre>allgather login {opened.server_url}</pre>
              <p>Paste this code at the hidden prompt:</p>
              <textarea readOnly aria-label="CLI pairing code" value={opened.pairing_code} />
              <div className="actions">
                <button
                  type="button"
                  onClick={() => void run(() => navigator.clipboard.writeText(opened.pairing_code))}
                >
                  Copy CLI code
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await request(`/api/cli/pairings/${opened.pairing_id}/revoke`, {});
                      await load();
                    })
                  }
                >
                  Cancel CLI code
                </button>
              </div>
              <p className="muted small">
                {current?.state === "claimed"
                  ? "Waiting for the CLI to save its credentials. "
                  : ""}
                Expires in {Math.max(0, Math.ceil((Date.parse(opened.expires_at) - now) / 1000))}{" "}
                seconds.
              </p>
            </>
          ) : (
            <p>
              {current?.state === "connected"
                ? `${current.name} is connected. The CLI saved its credentials.`
                : "This pairing code is closed or expired. Create a new one to connect."}
            </p>
          )}
        </div>
      )}
      {!!options?.pairings.length && (
        <ul className="plain-list">
          {options.pairings.slice(0, 5).map((row) => (
            <li key={row.pairing_id}>
              <span>
                <strong>{row.name}</strong>
                <small>{row.state}</small>
              </span>
              {["open", "claimed"].includes(row.state) && row.pairing_id !== opened?.pairing_id && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await request(`/api/cli/pairings/${row.pairing_id}/revoke`, {});
                      await load();
                    })
                  }
                >
                  Cancel CLI code
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
