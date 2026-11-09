import { useEffect, useState } from "react";
import { type ConnectionIdentity, connectionActorLabel } from "../shared/client-access.ts";
import type { Page } from "../shared/contracts.ts";
import { call } from "./api.ts";
import { ErrorText, PageHeading } from "./ui.tsx";

interface Entry {
  connection?: ConnectionIdentity | null;
  id: string;
  operation: string;
  operator_name: string;
  operator_kind: string;
  session_id: string | null;
  role_name: string | null;
  connection_id: string;
  inlet: string;
  at: string;
  changes: {
    sequence: number;
    entity_type: string;
    entity_id: string;
    change_kind: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }[];
}
export function Activity({ project, refresh }: { project: string; refresh: number }) {
  const [operator, setOperator] = useState(""),
    [task, setTask] = useState(""),
    [run, setRun] = useState(""),
    [connection, setConnection] = useState(""),
    [operation, setOperation] = useState(""),
    [since, setSince] = useState(""),
    [until, setUntil] = useState(""),
    [entity, setEntity] = useState(""),
    [page, setPage] = useState<Page<Entry>>({ items: [], total: 0, next_cursor: null }),
    [cursor, setCursor] = useState(0),
    [error, setError] = useState("");
  const filters = JSON.stringify({
    project_id: project || undefined,
    operator_id: operator || undefined,
    task_id: task || undefined,
    run_id: run || undefined,
    connection_id: connection || undefined,
    operation: operation || undefined,
    entity_id: entity || undefined,
    since: since ? new Date(since).toISOString() : undefined,
    until: until ? new Date(until).toISOString() : undefined,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh invalidates the audit snapshot.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () =>
        void call<Page<Entry>>("audit_list", { ...JSON.parse(filters), cursor, limit: 25 })
          .then((data) => {
            if (live) {
              setPage(data);
              setError("");
            }
          })
          .catch((e) => {
            if (live) setError(e.message);
          }),
      150,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [filters, cursor, refresh]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset the page when filters change.
  useEffect(() => setCursor(0), [filters]);
  return (
    <div className="history-view">
      <PageHeading>
        <div>
          <h1>Activity</h1>
          <p>Owner and agent changes, with their recorded effects.</p>
        </div>
      </PageHeading>
      <p className="muted small">
        Names are reported by clients. Access comes from the authenticated connection. Git
        collection and sign-in activity are outside this work log.
      </p>
      <details className="filter-details">
        <summary>Filter activity</summary>
        <div className="filter-grid">
          <label>
            Operator
            <input
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
              placeholder="Actor ID"
            />
          </label>
          <label>
            Task ID
            <input value={task} onChange={(e) => setTask(e.target.value)} />
          </label>
          <label>
            Run ID
            <input value={run} onChange={(e) => setRun(e.target.value)} />
          </label>
          <label>
            Connection ID
            <input value={connection} onChange={(e) => setConnection(e.target.value)} />
          </label>
          <label>
            Operation
            <input value={operation} onChange={(e) => setOperation(e.target.value)} />
          </label>
          <label>
            Entity ID
            <input value={entity} onChange={(e) => setEntity(e.target.value)} />
          </label>
          <label>
            From
            <input type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} />
          </label>
          <label>
            Through
            <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
        </div>
      </details>
      <ErrorText>{error}</ErrorText>
      <ol className="audit-list">
        {page.items.map((entry) => (
          <li key={entry.id}>
            <strong>{connectionActorLabel(entry.connection, entry.operator_name)}</strong>
            {entry.role_name ? ` as ${entry.role_name}` : ""} ·{" "}
            {entry.operation.replaceAll("_", " ")}
            <small>
              {new Date(entry.at).toLocaleString()} · {entry.inlet} · {entry.connection_id}
              {entry.session_id ? ` · ${entry.session_id}` : ""}
            </small>
            <details>
              <summary>{entry.changes.length} recorded changes</summary>
              {entry.changes.map((c) => (
                <div className="audit-change" key={c.sequence}>
                  <p>
                    <strong>
                      {c.change_kind} · {c.entity_type}
                    </strong>{" "}
                    <code>{c.entity_id}</code>
                  </p>
                  <dl>
                    {Object.keys(c.after ?? c.before ?? {})
                      .filter(
                        (key) => JSON.stringify(c.before?.[key]) !== JSON.stringify(c.after?.[key]),
                      )
                      .map((key) => (
                        <div key={key}>
                          <dt>{key.replaceAll("_", " ")}</dt>
                          <dd>
                            {c.before && <del>{JSON.stringify(c.before[key] ?? null)}</del>}
                            {c.before && c.after && " → "}
                            {c.after && <span>{JSON.stringify(c.after[key] ?? null)}</span>}
                          </dd>
                        </div>
                      ))}
                  </dl>
                </div>
              ))}
            </details>
          </li>
        ))}
      </ol>
      <div className="pagination">
        <span className="muted small">{page.total} operations</span>
        {cursor > 0 && (
          <button type="button" onClick={() => setCursor(Math.max(0, cursor - 25))}>
            Previous
          </button>
        )}
        {page.next_cursor !== null && (
          <button type="button" onClick={() => setCursor(page.next_cursor ?? 0)}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}
