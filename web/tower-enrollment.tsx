import { useCallback, useEffect, useState } from "react";
import type { Machine } from "../shared/contracts.ts";
import type { MachineScope } from "../shared/tower-acp.ts";
import { request } from "./api.ts";
import { CopyId } from "./copy-id.tsx";
import { Brand, ErrorText, LoginFrame, useAction } from "./ui.tsx";

const labels: Record<MachineScope, string> = {
  read: "Read status and the repository catalog; report checkout observations",
  send: "Send messages to local sessions",
  "acp:control":
    "Launch and control managed agents, collect their transcripts, and answer native permission requests",
  "terminal:control": "Launch named coding agents in terminals and stop those runtimes",
};
interface Invitation {
  invitation_id: string;
  machine_id: string | null;
  node_label: string | null;
  scopes: MachineScope[];
  granted_scopes: MachineScope[] | null;
  state: string;
  expires_at: string;
  enrollment_id: string | null;
}
interface Issued {
  invitation_id: string;
  pairing_code: string;
  expires_at: string;
  server_url: string;
}
export function TowerPairing({ machines, changed }: { machines: Machine[]; changed: () => void }) {
  const [machine, setMachine] = useState(""),
    [label, setLabel] = useState(""),
    [scopes, setScopes] = useState<MachineScope[]>(["read", "send"]);
  const [issued, setIssued] = useState<Issued | null>(null),
    [rows, setRows] = useState<Invitation[]>([]);
  const { busy, error, run } = useAction();
  const load = useCallback(
    async () => setRows(await request<Invitation[]>("/api/tower/invitations")),
    [],
  );
  useEffect(() => {
    void run(load);
  }, [load, run]);
  useEffect(() => {
    if (!issued) return;
    const timer = setInterval(() => void run(load), 2000);
    return () => clearInterval(timer);
  }, [issued, load, run]);
  const current = issued ? rows.find((row) => row.invitation_id === issued.invitation_id) : null;
  const usable =
    issued &&
    Date.parse(issued.expires_at) > Date.now() &&
    (!current || ["open", "claimed"].includes(current.state));
  return (
    <section className="pairing">
      <h3>Pair a Tower node</h3>
      <p>
        Create a code here, then use it on the development machine. The code expires after ten
        minutes and pairs one node.
      </p>
      <ErrorText>{error}</ErrorText>
      {issued ? (
        <>
          {usable ? (
            <>
              <p>Run this command on the target machine:</p>
              <pre className="pairing-command">
                tower-cli login {issued.server_url} {issued.pairing_code}
              </pre>
              <textarea readOnly aria-label="Pairing code" value={issued.pairing_code} />
              <button
                type="button"
                onClick={() =>
                  void run(() =>
                    navigator.clipboard.writeText(
                      `tower-cli login ${issued.server_url} ${issued.pairing_code}`,
                    ),
                  )
                }
              >
                Copy pairing command
              </button>
              <p className="muted small">
                Expires {new Date(issued.expires_at).toLocaleTimeString()}. No second browser
                approval is needed.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await request(`/api/tower/invitations/${issued.invitation_id}/revoke`, {});
                    await load();
                  })
                }
              >
                Cancel code
              </button>
            </>
          ) : (
            <p>
              Pairing {current?.state ?? "expired"}.{" "}
              {current?.state === "confirmed"
                ? "The machine saved its credential."
                : "Create another code if needed."}
            </p>
          )}
          {current?.granted_scopes && (
            <p>
              Granted: {current.granted_scopes.join(", ")}. Local Tower restrictions still apply.
            </p>
          )}
          <button type="button" disabled={busy} onClick={() => setIssued(null)}>
            Create another code
          </button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              setIssued(
                await request<Issued>("/api/tower/invitations", {
                  node_label: label.trim() || undefined,
                  machine_id: machine || undefined,
                  scopes,
                }),
              );
              await load();
              changed();
            });
          }}
        >
          <label>
            Node
            <select
              value={machine}
              onChange={(event) => {
                setMachine(event.target.value);
                setLabel("");
              }}
            >
              <option value="">New node</option>
              {machines
                .filter((machine) => !!machine.host_id)
                .map((machine) => (
                  <option key={machine.id} value={machine.id}>
                    {machine.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Node name
            <input
              maxLength={160}
              value={label}
              placeholder={machine ? "Keep the current name" : "Optional name"}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <fieldset>
            <legend>Allow this node to</legend>
            {(Object.keys(labels) as MachineScope[]).map((scope) => (
              <label key={scope} className="permission-choice">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(event) =>
                    setScopes((previous) =>
                      event.target.checked
                        ? [...previous, scope]
                        : previous.filter((value) => value !== scope),
                    )
                  }
                />
                <span>{labels[scope]}</span>
              </label>
            ))}
          </fieldset>
          <p className="muted small">
            Managed control also needs local acp:control permission in Tower. Terminal launch needs
            local terminal:control permission. An existing node must be selected before re-pairing.
          </p>
          {machine && (
            <p className="notice">
              Confirmation replaces this node's earlier keys. Its identity, local checkouts, and
              cached policy remain.
            </p>
          )}
          <button type="submit" className="primary" disabled={busy || !scopes.length}>
            Create pairing code
          </button>
        </form>
      )}
      {rows
        .filter(
          (row) =>
            ["open", "claimed"].includes(row.state) && row.invitation_id !== issued?.invitation_id,
        )
        .map((row) => (
          <div className="section-line" key={row.invitation_id}>
            <span>
              {row.node_label ?? "Tower node"} · {row.state}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await request(`/api/tower/invitations/${row.invitation_id}/revoke`, {});
                  await load();
                })
              }
            >
              Cancel code
            </button>
          </div>
        ))}
    </section>
  );
}
export function TowerEnrollmentView() {
  const id = location.pathname.split("/").at(-1)!;
  const [info, setInfo] = useState<{
    host_id: string;
    tower_version: string;
    node_label: string;
    scopes: MachineScope[];
    state: string;
    expires_at: string;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = () =>
      void request<NonNullable<typeof info>>(`/api/tower/enrollments/${encodeURIComponent(id)}`)
        .then((info) => {
          if (live) setInfo(info);
        })
        .catch((error) => {
          if (live) setError(error.message);
        });
    load();
    const timer = setInterval(load, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id]);
  return (
    <LoginFrame>
      <Brand />
      <h1>Tower pairing status</h1>
      <ErrorText>{error}</ErrorText>
      {info ? (
        <>
          <p>
            <strong>{info.node_label}</strong> · {info.state}
          </p>
          <CopyId value={info.host_id} />
          <p className="muted small">Tower {info.tower_version}</p>
          <ul>
            {info.scopes.map((scope) => (
              <li key={scope}>{labels[scope]}</li>
            ))}
          </ul>
          <p>
            {info.state === "confirmed"
              ? "The machine saved its credential and completed pairing."
              : info.state === "approved"
                ? "The code authorized this node. Return to the terminal to finish saving the credential."
                : "This setup cannot continue. Create a new code from Development machines if needed."}
          </p>
          <a href="/?view=sessions">Development machines</a>
        </>
      ) : (
        !error && <p>Reading pairing status…</p>
      )}
    </LoginFrame>
  );
}
