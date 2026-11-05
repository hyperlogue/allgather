import { useState } from "react";
import type { Page, Relation } from "../shared/contracts.ts";
import { call } from "./api.ts";
import { Dialog, ErrorText, useAction } from "./ui.tsx";

interface Entity {
  id: string;
  kind: string;
  project_id: string | null;
  value: Record<string, unknown> | null;
}
interface Context {
  entity: Entity;
  neighbors: Entity[];
  relations: Page<Relation>;
}
function title(e: Entity) {
  return String(e.value?.title ?? e.value?.label ?? e.value?.name ?? e.value?.message ?? e.id);
}
function destination(e: Entity) {
  const v = e.value;
  if (e.kind === "task")
    return `/?view=tasks&task=${encodeURIComponent(e.id)}&project=${encodeURIComponent(e.project_id ?? "")}`;
  if (e.kind === "session") return `/?view=sessions&session=${encodeURIComponent(e.id)}`;
  if (e.kind.startsWith("artifact")) {
    const id = e.kind === "artifact" ? e.id : String(v?.artifactId ?? e.id.split("@")[0]);
    return `/?view=artifacts&artifact=${encodeURIComponent(id)}${v?.seq ? `&version=${v.seq}` : ""}`;
  }
  return null;
}
export function ContextLink({ id, label = "View context" }: { id: string; label?: string }) {
  const [data, setData] = useState<Context | null>(null),
    [open, setOpen] = useState(false),
    { error, busy, run } = useAction();
  const load = (id: string) => {
    setOpen(true);
    void run(async () =>
      setData(await call<Context>("links_context", { entity_id: id, limit: 100 })),
    );
  };
  return (
    <>
      <button type="button" className="quiet" disabled={busy} onClick={() => load(id)}>
        {label}
      </button>
      {open && (
        <Dialog title="Connected work" close={() => setOpen(false)}>
          <ErrorText>{error}</ErrorText>
          {data && (
            <>
              <p className="muted small">{data.entity.kind.replaceAll("_", " ")}</p>
              <h2>{title(data.entity)}</h2>
              {destination(data.entity) && (
                <p>
                  <a href={destination(data.entity)!}>
                    Open {data.entity.kind.replaceAll("_", " ")}
                  </a>
                </p>
              )}
              {data.entity.value?.body !== undefined && (
                <p className="context-body">{String(data.entity.value.body)}</p>
              )}
              <ul className="plain-list">
                {data.relations.items.map((r) => {
                  const other = data.neighbors.find(
                    (n) => n.id === (r.source_id === data.entity.id ? r.target_id : r.source_id),
                  );
                  return other ? (
                    <li key={r.id}>
                      <span>
                        <small>
                          {r.type} · {other.kind.replaceAll("_", " ")}
                        </small>
                        <button type="button" className="quiet" onClick={() => load(other.id)}>
                          {title(other)}
                        </button>
                        {r.reason && <p>{r.reason}</p>}
                      </span>
                    </li>
                  ) : null;
                })}
              </ul>
              {!data.relations.total && <p className="muted">No context links yet.</p>}
              <details>
                <summary>Record details</summary>
                <pre>{JSON.stringify(data.entity.value, null, 2)}</pre>
              </details>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
