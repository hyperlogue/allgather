import { useEffect, useState } from "react";
import { request } from "./api.ts";
import { ErrorText, useAction } from "./ui.tsx";

export interface ApprovalView {
  id: string;
  operation: string;
  operation_key: string;
  state: string;
  revision: number;
  created_at: string;
  expires_at: string;
  operator_name: string;
  client_id: string;
  machine_name: string | null;
  project_name: string | null;
  input: Record<string, unknown>;
  target: Record<string, unknown>;
  result: unknown;
  error: { code: string; message: string } | null;
}
const titles: Record<string, string> = {
  session_launch: "Launch an agent",
  session_prompt: "Send a prompt",
  session_cancel: "Stop execution",
  session_resume: "Resume a conversation",
};
const title = (row: ApprovalView) =>
  row.operation === "session_cancel"
    ? row.target.cancel_mode === "turn"
      ? "Cancel the current turn"
      : "Stop the execution"
    : (titles[row.operation] ?? row.operation);
export function useApprovals(refresh: number) {
  const [rows, setRows] = useState<ApprovalView[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Server events invalidate this snapshot.
  useEffect(() => {
    let live = true;
    void request<ApprovalView[]>("/api/approvals")
      .then((rows) => {
        if (live) setRows(rows);
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [refresh]);
  return rows;
}
export function ApprovalsView({ rows, changed }: { rows: ApprovalView[]; changed: () => void }) {
  const [selected, setSelected] = useState(
    new URLSearchParams(location.search).get("request") ?? "",
  );
  const [linked, setLinked] = useState<ApprovalView | null>(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let live = true;
    setLinked(null);
    setLoadError("");
    if (selected && !rows.some((row) => row.id === selected))
      void request<ApprovalView>(`/api/approvals/${encodeURIComponent(selected)}`)
        .then((row) => {
          if (live) setLinked(row);
        })
        .catch((error) => {
          if (live) setLoadError(error.message);
        });
    return () => {
      live = false;
    };
  }, [selected, rows]);
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (!selected && rows.length)
      setSelected((rows.find((row) => row.state === "needs_approval") ?? rows[0]).id);
  }, [rows, selected]);
  const current = selected ? (rows.find((row) => row.id === selected) ?? linked) : null;
  const result = current?.result as { session?: { id: string }; session_id?: string } | null;
  const sessionId = result?.session?.id ?? result?.session_id;
  const decide = (decision: "approve" | "deny") => {
    if (current) {
      setSelected(current.id);
      void run(async () => {
        await request(`/api/approvals/${current.id}/decision`, {
          decision,
          expected_revision: current.revision,
        });
        changed();
      });
    }
  };
  return (
    <div className="approvals">
      <h1>Request approvals</h1>
      <p>
        Review one exact request. Approval admits work to Allgather; it does not mean the coding
        agent has completed it.
      </p>
      <ErrorText>{loadError || error}</ErrorText>
      <div className="session-layout">
        <section className="session-list">
          {rows.map((row) => (
            <button
              type="button"
              className={`task-row ${current?.id === row.id ? "selected" : ""}`}
              key={row.id}
              onClick={() => {
                setSelected(row.id);
                const url = new URL(location.href);
                url.searchParams.set("request", row.id);
                history.replaceState(null, "", url);
              }}
            >
              <span>
                <strong>{title(row)}</strong>
                <small>
                  {row.operator_name} · {row.state.replaceAll("_", " ")}
                </small>
              </span>
            </button>
          ))}
          {!rows.length && <p className="empty-copy">No requests need review.</p>}
        </section>
        {current && (
          <section className="approval-detail">
            <h2>{title(current)}</h2>
            <p>
              Requested by <strong>{current.operator_name}</strong>. The client supplied this name.
            </p>
            <dl>
              <dt>State</dt>
              <dd>{current.state.replaceAll("_", " ")}</dd>
              <dt>Expires</dt>
              <dd>{new Date(current.expires_at).toLocaleString()}</dd>
            </dl>
            <p>
              <strong>{current.machine_name ?? "Machine"}</strong> ·{" "}
              {current.project_name ?? "Unassigned"}
            </p>
            {typeof current.input.harness === "string" && (
              <p>
                Agent: <strong>{current.input.harness}</strong>
                {current.input.mode === "terminal" ? " (terminal)" : ""}
              </p>
            )}
            {typeof current.input.cwd === "string" && (
              <p>
                Directory: <code>{current.input.cwd}</code>
              </p>
            )}
            {current.input.force === true && (
              <p className="notice">
                Force resume stops and cleans up the recorded earlier executions before starting a
                replacement.
              </p>
            )}
            {Array.isArray(current.input.content) && (
              <pre className="approval-payload">
                {current.input.content
                  .map((block: { text?: string }) => block.text ?? "[Non-text input]")
                  .join("\n")}
              </pre>
            )}
            <details>
              <summary>Exact request and target</summary>
              <pre className="approval-payload">
                {JSON.stringify({ target: current.target, request: current.input }, null, 2)}
              </pre>
            </details>
            {current.error && <ErrorText>{current.error.message}</ErrorText>}
            {current.state === "succeeded" && (
              <p className="notice">
                Request admitted. Use the session and command status to check execution.
                {sessionId && (
                  <>
                    {" "}
                    <a href={`/?view=sessions&session=${encodeURIComponent(sessionId)}`}>
                      Open session
                    </a>
                  </>
                )}
              </p>
            )}
            {current.state === "needs_approval" && (
              <div className="actions">
                <button type="button" disabled={busy} onClick={() => decide("deny")}>
                  Deny request
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => decide("approve")}
                >
                  Approve this request
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
