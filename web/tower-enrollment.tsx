import { useEffect, useState } from "react";
import { request } from "./api.ts";
import { ErrorText, useAction } from "./ui.tsx";

export function TowerEnrollmentView() {
  const id = location.pathname.split("/").at(-1)!;
  const [info, setInfo] = useState<{
    host_id: string;
    tower_version: string;
    node_label: string;
    requested_scopes: string[];
    expires_at: string;
    state: string;
  } | null>(null);
  const [label, setLabel] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [loadError, setLoadError] = useState("");
  const { busy, error, run } = useAction();
  useEffect(() => {
    void request<NonNullable<typeof info>>(`/api/tower/enrollments/${id}`)
      .then((v) => {
        setInfo(v);
        setLabel(v.node_label);
        setSelected(v.requested_scopes);
      })
      .catch((e) => setLoadError(e.message));
  }, [id]);
  const decide = (decision: "authorize" | "deny") =>
    void run(async () => {
      const result = await request<{ state: string }>(`/api/tower/enrollments/${id}/decision`, {
        decision,
        ...(decision === "authorize" ? { node_label: label, scopes: selected } : {}),
      });
      setInfo((v) => v && { ...v, state: result.state });
    });
  return (
    <main className="login">
      <span className="brand">allgather</span>
      <h1>Connect this Tower node</h1>
      <ErrorText>{error || loadError}</ErrorText>
      {info && info.state === "pending" ? (
        <>
          <p>Approve only the setup you started. Compare this host ID with the terminal.</p>
          <code style={{ overflowWrap: "anywhere" }}>{info.host_id}</code>
          <p className="muted small">
            Tower {info.tower_version} · Expires {new Date(info.expires_at).toLocaleTimeString()}
          </p>
          <label>
            Node name
            <input maxLength={160} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <fieldset>
            <legend>Allow this connection to</legend>
            {info.requested_scopes.map((scope) => (
              <label key={scope} style={{ display: "flex", gap: 8, alignItems: "start" }}>
                <input
                  type="checkbox"
                  checked={selected.includes(scope)}
                  onChange={(e) =>
                    setSelected((s) =>
                      e.target.checked ? [...s, scope] : s.filter((v) => v !== scope),
                    )
                  }
                  style={{ width: "auto" }}
                />
                <span>
                  {
                    (
                      {
                        read: "Read status and the repository catalog; report checkout observations",
                        send: "Send messages to local sessions",
                        "terminal:control":
                          "Launch named coding agents in terminals and stop those runtimes; no remote prompt or terminal stream",
                        "acp:control":
                          "Start and control managed agent sessions, send prompts, and answer permission requests",
                      } as Record<string, string>
                    )[scope]
                  }
                </span>
              </label>
            ))}
          </fieldset>
          <p>
            Local Tower permissions and rules still apply. Managed control needs an explicit local{" "}
            <code>acp:control</code> grant; terminal launch needs a separate explicit{" "}
            <code>terminal:control</code> grant.
          </p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => decide("deny")}>
              Deny
            </button>
            <button
              className="primary"
              type="button"
              disabled={busy || !label.trim() || !selected.length}
              onClick={() => decide("authorize")}
            >
              Authorize
            </button>
          </div>
        </>
      ) : info ? (
        <p>
          {info.state === "approved" || info.state === "confirmed"
            ? "Authorized. Return to your terminal to finish setup."
            : `This setup is ${info.state}. Start tower login again if needed.`}
        </p>
      ) : (
        !loadError && <p>Reading the setup request…</p>
      )}
    </main>
  );
}
