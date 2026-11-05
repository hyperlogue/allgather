import { useEffect, useRef, useState } from "react";
import { permissions, type Scope } from "../shared/permissions.ts";
import { noResources, type ResourceGrants } from "../shared/resource-grants.ts";
import { request } from "./api.ts";
import { ErrorText, useAction } from "./ui.tsx";

interface ConsentInfo {
  name: string;
  scopes: Scope[];
  redirect_uri: string;
  audience: "mcp" | "api";
  resource: string;
  projects: { id: string; name: string }[];
  machines: { id: string; name: string }[];
}
function Category({
  label,
  scopes,
  selected,
  change,
}: {
  label: string;
  scopes: Scope[];
  selected: Set<Scope>;
  change: (scopes: Scope[], allowed: boolean) => void;
}) {
  const checkbox = useRef<HTMLInputElement>(null);
  const count = scopes.filter((scope) => selected.has(scope)).length;
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = count > 0 && count < scopes.length;
  }, [count, scopes.length]);
  return (
    <details className="permission-category">
      <summary>
        <input
          ref={checkbox}
          type="checkbox"
          aria-label={`Grant all ${label.toLowerCase()} permissions`}
          checked={count === scopes.length}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => change(scopes, event.target.checked)}
        />
        <span>{label}</span>
        <small>
          {count} of {scopes.length}
        </small>
      </summary>
      {scopes.map((scope) => (
        <label className="permission-choice" key={scope}>
          <input
            type="checkbox"
            checked={selected.has(scope)}
            onChange={(event) => change([scope], event.target.checked)}
          />
          <span>{permissions[scope].label}</span>
        </label>
      ))}
    </details>
  );
}
function ResourceCategory({
  title,
  items,
  selected,
  change,
}: {
  title: string;
  items: { id: string; name: string }[];
  selected: "*" | string[];
  change: (value: "*" | string[]) => void;
}) {
  return (
    <details className="permission-category">
      <summary>
        <span>{title}</span>
        <small>{selected === "*" ? "All, including new" : `${selected.length} selected`}</small>
      </summary>
      <label className="permission-choice">
        <input
          type="checkbox"
          checked={selected === "*"}
          onChange={(event) => change(event.target.checked ? "*" : [])}
        />
        <span>All {title.toLowerCase()}, including new ones</span>
      </label>
      {items.map((item) => (
        <label key={item.id} className="permission-choice">
          <input
            type="checkbox"
            checked={selected === "*" || selected.includes(item.id)}
            onChange={(event) => {
              const ids = new Set(selected === "*" ? items.map((item) => item.id) : selected);
              if (event.target.checked) ids.add(item.id);
              else ids.delete(item.id);
              change([...ids]);
            }}
          />
          <span>{item.name}</span>
        </label>
      ))}
    </details>
  );
}
export function Consent() {
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [operatorName, setOperatorName] = useState("");
  const [selected, setSelected] = useState(new Set<Scope>());
  const [keepAccess, setKeepAccess] = useState(true);
  const [resources, setResources] = useState<ResourceGrants>(noResources);
  const { busy, error, run } = useAction();
  useEffect(() => {
    void request<ConsentInfo>(`/api/oauth/request${location.search}`)
      .then((value) => {
        setInfo(value);
        setOperatorName(value.name);
        setSelected(new Set(value.scopes.filter((scope) => permissions[scope].defaultAllowed)));
      })
      .catch((error) => setLoadError(error.message));
  }, []);
  const params = Object.fromEntries(new URLSearchParams(location.search));
  const categories = new Map<string, Scope[]>();
  for (const scope of info?.scopes ?? []) {
    const category = permissions[scope].category;
    categories.set(category, [...(categories.get(category) ?? []), scope]);
  }
  const change = (scopes: Scope[], allowed: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      for (const scope of scopes)
        if (allowed) next.add(scope);
        else next.delete(scope);
      return next;
    });
  return (
    <main className="login consent">
      <span className="brand">
        <span aria-hidden="true" className="brand-mark">
          ▦
        </span>{" "}
        allgather
      </span>
      <h1>Connect an agent</h1>
      <ErrorText>{loadError || error}</ErrorText>
      {info ? (
        <>
          <p>
            <strong>{info.name}</strong> requests{" "}
            {info.audience === "mcp" ? "MCP connector access" : "private API and CLI access"}.
          </p>
          <p className="muted small">{info.resource}</p>
          <p className="notice">
            The application supplied this name. Allgather has not verified its identity. Approve
            only a connection you started.
          </p>
          <label>
            Agent name
            <input
              maxLength={160}
              value={operatorName}
              onChange={(event) => setOperatorName(event.target.value)}
            />
          </label>
          <div className="permission-tree">
            {[...categories].map(([label, scopes]) => (
              <Category
                key={label}
                label={label}
                scopes={scopes}
                selected={selected}
                change={change}
              />
            ))}
          </div>
          <div className="permission-tree">
            <p>
              Project and machine access are separate. Both are required for a session on a machine.
            </p>
            <ResourceCategory
              title="Projects"
              items={info.projects}
              selected={resources.project_ids}
              change={(project_ids) => setResources((previous) => ({ ...previous, project_ids }))}
            />
            <ResourceCategory
              title="Machines"
              items={info.machines}
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
            <p className="muted small">
              Shared repositories require all linked projects. Links and path prefixes do not grant
              access.
            </p>
          </div>
          {(selected.has("transcripts:read") ||
            selected.has("artifacts:read") ||
            selected.has("commits:read")) && (
            <p className="notice">
              Selected conversations, artifacts and Git data can be sent to this client's provider.
              These records can contain private information or secrets.
            </p>
          )}
          {selected.has("admin") && (
            <p className="notice">
              Administrative access includes machine credentials, policy changes and backups.
            </p>
          )}
          <label className="permission-choice">
            <input
              type="checkbox"
              checked={keepAccess}
              onChange={(event) => setKeepAccess(event.target.checked)}
            />
            <span>Keep this connection signed in</span>
          </label>
          <p className="muted small">
            Return to {new URL(info.redirect_uri).host}. You can revoke access from Connections.
          </p>
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const url = new URL(info.redirect_uri);
                url.searchParams.set("error", "access_denied");
                if (params.state) url.searchParams.set("state", params.state);
                location.assign(url.toString());
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || selected.size === 0}
              onClick={() =>
                void run(async () => {
                  const result = await request<{ redirect_uri: string }>("/api/oauth/authorize", {
                    ...params,
                    scope: [...selected].join(" "),
                    operator_name: operatorName,
                    keep_access: String(keepAccess),
                    resource_grants: JSON.stringify(resources),
                  });
                  location.assign(result.redirect_uri);
                })
              }
            >
              Allow access
            </button>
          </div>
        </>
      ) : (
        !loadError && <p>Reading the access request…</p>
      )}
    </main>
  );
}
