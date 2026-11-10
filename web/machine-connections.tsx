import { useEffect, useState } from "react";
import type { Machine } from "../shared/contracts.ts";
import { call } from "./api.ts";
import { CopyId } from "./copy-id.tsx";
import { Icon } from "./icons.tsx";
import { ErrorText } from "./ui.tsx";

export function MachineConnections({ refresh, manage }: { refresh: number; manage: () => void }) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Server events invalidate the machine snapshot.
  useEffect(() => {
    let active = true;
    void call<Machine[]>("machines_list")
      .then((rows) => {
        if (active) {
          setMachines(rows);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  return (
    <section className="history-section machine-connections">
      <div className="section-line">
        <h2>Development machines</h2>
        <button type="button" onClick={manage}>
          Manage machines
        </button>
      </div>
      <ErrorText>{error}</ErrorText>
      <ul className="plain-list">
        {machines.map((machine) => (
          <li key={machine.id}>
            <Icon name="sessions" />
            <span>
              <strong>{machine.name}</strong>
              <small>
                <CopyId value={machine.id} />
              </small>
            </span>
            <span className={`machine-status ${machine.connected ? "online" : ""}`}>
              <i className={`presence ${machine.connected ? "running" : "offline"}`} />
              {machine.connected ? "Connected" : "Offline"}
            </span>
          </li>
        ))}
      </ul>
      {!machines.length && !error && (
        <p className="empty-copy">Pair Tower on a development machine to connect it here.</p>
      )}
    </section>
  );
}
