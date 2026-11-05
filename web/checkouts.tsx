import { useEffect, useState } from "react";
import type { Machine, Repository } from "../shared/contracts.ts";
import type { CheckoutObservation } from "../shared/tower-catalog.ts";
import { call } from "./api.ts";
import { ErrorText } from "./ui.tsx";

export function Checkouts({
  repositories,
  filtered,
  refresh,
}: {
  repositories: Repository[];
  filtered: boolean;
  refresh: number;
}) {
  const [rows, setRows] = useState<CheckoutObservation[]>([]),
    [machines, setMachines] = useState<Machine[]>([]),
    [removed, setRemoved] = useState(false),
    [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh reloads committed observations.
  useEffect(() => {
    let active = true;
    void Promise.all([
      call<CheckoutObservation[]>("checkouts_list", { include_removed: removed }),
      call<Machine[]>("machines_list"),
    ])
      .then(([observations, nodes]) => {
        if (active) {
          setRows(observations);
          setMachines(nodes);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [refresh, removed]);
  const ids = new Set(repositories.map((r) => r.id));
  const visible = rows.filter(
    (row) => !filtered || (row.repository_id !== null && ids.has(row.repository_id)),
  );
  return (
    <section className="history-section checkout-list">
      <div className="section-line">
        <h2>Local checkouts</h2>
        <label className="check">
          <input type="checkbox" checked={removed} onChange={(e) => setRemoved(e.target.checked)} />
          Show removed checkouts
        </label>
      </div>
      <p className="muted small">
        Tower reports local clones and worktrees. These are dated observations; offline or
        unavailable paths can have changed since the last report.
      </p>
      <ErrorText>{error}</ErrorText>
      {machines
        .filter((m) => m.catalog_sync?.catalog_error || m.catalog_sync?.checkout_error)
        .map((m) => (
          <p key={m.id} className="error">
            {m.name}: {m.catalog_sync?.catalog_error ?? m.catalog_sync?.checkout_error}
          </p>
        ))}
      {visible.map((row) => {
        const machine = machines.find((m) => m.id === row.machine_id),
          repo = repositories.find((r) => r.id === row.repository_id);
        const flags = [
          !row.present ? "Removed" : null,
          row.available === false ? "Unavailable" : null,
          row.dirty ? "Uncommitted changes" : null,
          row.conflicts ? "Conflicts" : null,
          row.locked ? "Locked" : null,
          row.prunable ? "Prunable" : null,
        ].filter(Boolean);
        return (
          <article className="repo-row" key={`${row.machine_id}:${row.checkout_id ?? row.path}`}>
            <div className="section-line">
              <strong>
                {machine?.name ?? row.machine_id} ·{" "}
                {repo?.name ?? (row.repository_id ? "Linked repository" : "Unlinked repository")}
              </strong>
              <small>{row.connected ? "Connected" : "Observation stale"}</small>
            </div>
            <p>
              <code>{row.path}</code>
            </p>
            <p>
              {row.branch ?? "Detached or unknown branch"}
              {row.head && (
                <>
                  {" "}
                  · <code>{row.head.slice(0, 12)}</code>
                </>
              )}
              {flags.length > 0 && ` · ${flags.join(" · ")}`}
            </p>
            {row.tracking_ref && (
              <p className="muted small">
                {row.tracking_ref} · {row.ahead ?? "?"} ahead · {row.behind ?? "?"} behind
              </p>
            )}
            <p className="muted small">
              {row.checkout_id ? (
                <>
                  <code>{row.machine_id}</code> / <code>{row.checkout_id}</code>
                </>
              ) : (
                "Legacy path observation; no Tower checkout ID"
              )}{" "}
              ·{" "}
              {row.observed_at === null
                ? "Observation time unknown"
                : new Date(row.observed_at).toLocaleString()}
            </p>
          </article>
        );
      })}
      {!visible.length && <p className="muted">No checkout observations match this view.</p>}
    </section>
  );
}
