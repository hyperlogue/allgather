import { useCallback, useEffect, useState } from "react";
import { request } from "./api.ts";
import { ErrorText, useAction } from "./ui.tsx";

interface Passkey {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string;
  revoked_at: string | null;
}
export function Passkeys() {
  const [keys, setKeys] = useState<Passkey[]>([]);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setKeys(await request<Passkey[]>("/api/passkeys")), []);
  useEffect(() => {
    void run(load);
  }, [load, run]);
  return (
    <section className="history-section">
      <h2>Passkeys</h2>
      <p>
        Browsers stay signed in while you use Allgather. After 30 days of inactivity, sign in again
        with your passkey.
      </p>
      <p className="muted small">
        To add or replace a passkey, run <code>allgather-server login</code> on your server and open
        the link on the device you want to use.
      </p>
      <ErrorText>{error}</ErrorText>
      <ul className="plain-list">
        {keys.map((key) => (
          <li key={key.id}>
            <span>
              <strong>{key.label}</strong>
              <small>
                {key.revoked_at
                  ? "Revoked"
                  : `Last used ${new Date(key.last_used_at).toLocaleString()}`}
              </small>
            </span>
            {!key.revoked_at && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      `Revoke ${key.label}? Browsers signed in with this passkey will be signed out. Use another passkey or a new server login link to return.`,
                    )
                  )
                    void run(async () => {
                      await request(`/api/passkeys/${encodeURIComponent(key.id)}/revoke`, {});
                      const session = await request<{ authenticated: boolean }>("/api/session");
                      if (!session.authenticated) location.reload();
                      else await load();
                    });
                }}
              >
                Revoke passkey
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
