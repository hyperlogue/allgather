// biome-ignore-all lint/suspicious/noArrayIndexKey: Content blocks keep their immutable source order within each keyed event.

import { useEffect, useRef, useState } from "react";
import type {
  AgentSession,
  Machine,
  Page,
  Role,
  SessionCommand,
  SessionEvent,
  SessionRuntime,
} from "../shared/contracts.ts";
import { hasManagedProtocol, hasTerminalProtocol, intersectControls } from "../shared/tower-acp.ts";
import type { CheckoutObservation } from "../shared/tower-catalog.ts";
import { call, mutation, request } from "./api.ts";
import { ContextLink } from "./context.tsx";
import { TowerPairing } from "./tower-enrollment.tsx";
import { TranscriptStorage } from "./transcript-storage.tsx";
import { Dialog, ErrorText, useAction } from "./ui.tsx";

type Data = Record<string, unknown>;
const managedAvailable = (machine: Machine | null | undefined) =>
  !!machine?.managed_enabled && hasManagedProtocol(machine.capabilities);
const terminalAvailable = (machine: Machine | null | undefined) =>
  !!machine?.managed_enabled &&
  machine.connected &&
  hasTerminalProtocol(machine.capabilities) &&
  machine.connection_scopes.includes("terminal:control");
interface OwnerRequest {
  id: string;
  kind: string;
  state: string;
  payload: Data;
  revision: number;
  runtime_generation: string;
}
function safeLink(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
function Content({ value }: { value: unknown }) {
  const blocks = Array.isArray(value) ? value : [value];
  return (
    <>
      {blocks.map((block, index) => {
        if (typeof block === "string") return <span key={index}>{block}</span>;
        if (!block || typeof block !== "object") return null;
        const b = block as Data;
        if (b.type === "text" || typeof b.text === "string")
          return <span key={index}>{String(b.text ?? "")}</span>;
        const asset =
          typeof b.asset_id === "string"
            ? `/api/session-assets/${encodeURIComponent(b.asset_id)}`
            : null;
        if (
          !asset &&
          b.type === "image" &&
          typeof b.data === "string" &&
          typeof b.mimeType === "string" &&
          /^image\/(png|jpeg|gif|webp)$/.test(b.mimeType) &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(b.data)
        )
          return (
            <img
              key={index}
              className="session-image"
              src={`data:${b.mimeType};base64,${b.data}`}
              alt="Captured session content"
            />
          );
        if (asset && b.type === "image")
          return (
            <img
              key={index}
              className="session-image"
              src={asset}
              alt={String(b.name ?? "Session image")}
            />
          );
        if (asset)
          return (
            <a key={index} href={asset} target="_blank" rel="noreferrer">
              {String(b.name ?? "Captured file")}
            </a>
          );
        const link = safeLink(b.uri);
        if (link)
          return (
            <a key={index} href={link} target="_blank" rel="noreferrer">
              {String(b.name ?? link)}
            </a>
          );
        if (b.resource && typeof b.resource === "object")
          return <Content key={index} value={b.resource} />;
        return (
          <details key={index}>
            <summary>{String(b.type ?? "Content")}</summary>
            <pre>{JSON.stringify(b, null, 2)}</pre>
          </details>
        );
      })}
    </>
  );
}
function RequestCard({
  item,
  live,
  send,
}: {
  item: OwnerRequest;
  live: boolean;
  send: (response: Data) => Promise<void>;
}) {
  const p = item.payload,
    schema = p.requestedSchema as
      | {
          properties?: Record<
            string,
            {
              type?: string;
              title?: string;
              description?: string;
              enum?: unknown[];
              default?: unknown;
              items?: { type?: string; enum?: string[] };
              minItems?: number;
            }
          >;
          required?: string[];
        }
      | undefined;
  const [values, setValues] = useState<Data>(() =>
      Object.fromEntries(
        Object.entries(schema?.properties ?? {})
          .filter(([, s]) => s.default !== undefined)
          .map(([key, s]) => [key, s.default]),
      ),
    ),
    { busy, error, run } = useAction();
  return (
    <section className="session-request">
      <strong>{item.kind === "permission" ? "Permission needed" : "Agent question"}</strong>
      <p>
        {typeof p.message === "string"
          ? p.message
          : typeof (p.toolCall as Data)?.title === "string"
            ? String((p.toolCall as Data).title)
            : "Review this request before responding."}
      </p>
      {p.toolCall !== undefined && (
        <details>
          <summary>Requested action</summary>
          <pre>{JSON.stringify(p.toolCall, null, 2)}</pre>
        </details>
      )}
      <ErrorText>{error}</ErrorText>
      {!live ? (
        <p className="muted">Reconnect to the active execution to respond.</p>
      ) : item.kind === "permission" ? (
        <div className="heading-actions">
          {(Array.isArray(p.options) ? p.options : []).map((o: Data) => (
            <button
              key={String(o.optionId)}
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => send({ outcome: { outcome: "selected", optionId: o.optionId } }))
              }
            >
              {String(o.name ?? o.optionId)}
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => send({ outcome: { outcome: "cancelled" } }))}
          >
            Cancel request
          </button>
        </div>
      ) : p.mode === "url" ? (
        <>
          <p className="muted small">{String(p.url ?? "")}</p>
          {safeLink(p.url) && (
            <a
              className="button-link"
              href={safeLink(p.url)!}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => void run(() => send({ action: "accept" }))}
            >
              Open external request
            </a>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => send({ action: "decline" }))}
          >
            Decline
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => send({ action: "accept", content: values }));
          }}
        >
          {Object.entries(schema?.properties ?? {}).map(([key, field]) =>
            field.type === "array" &&
            field.items?.type === "string" &&
            Array.isArray(field.items.enum) ? (
              <fieldset key={key} disabled={busy}>
                <legend>{field.title ?? key}</legend>
                <p className="muted small">
                  {field.description}
                  {field.minItems ? ` Choose at least ${field.minItems}.` : ""}
                </p>
                {field.items.enum.map((option) => (
                  <label key={option} className="checkbox">
                    <input
                      type="checkbox"
                      checked={Array.isArray(values[key]) && values[key].includes(option)}
                      onChange={(e) => {
                        const selected = Array.isArray(values[key])
                          ? (values[key] as string[])
                          : [];
                        setValues({
                          ...values,
                          [key]: e.target.checked
                            ? [...selected, option]
                            : selected.filter((v) => v !== option),
                        });
                      }}
                    />
                    {option}
                  </label>
                ))}
              </fieldset>
            ) : (
              <label key={key} htmlFor={`${item.id}-${key}`}>
                {field.title ?? key}
                {field.enum ? (
                  <select
                    id={`${item.id}-${key}`}
                    required={schema?.required?.includes(key)}
                    value={String(values[key] ?? "")}
                    onChange={(e) =>
                      setValues({
                        ...values,
                        [key]: field.enum?.find((v) => String(v) === e.target.value),
                      })
                    }
                  >
                    <option value="">Choose</option>
                    {field.enum.map((v) => (
                      <option key={String(v)} value={String(v)}>
                        {String(v)}
                      </option>
                    ))}
                  </select>
                ) : field.type === "boolean" ? (
                  <input
                    id={`${item.id}-${key}`}
                    type="checkbox"
                    checked={!!values[key]}
                    onChange={(e) => setValues({ ...values, [key]: e.target.checked })}
                  />
                ) : (
                  <input
                    id={`${item.id}-${key}`}
                    required={schema?.required?.includes(key)}
                    type={["number", "integer"].includes(field.type ?? "") ? "number" : "text"}
                    step={field.type === "integer" ? 1 : "any"}
                    value={String(values[key] ?? "")}
                    onChange={(e) =>
                      setValues({
                        ...values,
                        [key]: ["number", "integer"].includes(field.type ?? "")
                          ? Number(e.target.value)
                          : e.target.value,
                      })
                    }
                  />
                )}
                <small>{field.description}</small>
              </label>
            ),
          )}
          <div className="heading-actions">
            <button type="submit" className="primary" disabled={busy}>
              Send response
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => send({ action: "decline" }))}
            >
              Decline
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => send({ action: "cancel" }))}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
function SessionDetail({
  session,
  machines,
  refresh,
  changed,
}: {
  session: AgentSession;
  machines: Machine[];
  refresh: number;
  changed: () => void;
}) {
  const [runtime, setRuntime] = useState<SessionRuntime | null>(null),
    [checkout, setCheckout] = useState<CheckoutObservation | null>(null),
    [events, setEvents] = useState<SessionEvent[]>([]),
    [commands, setCommands] = useState<SessionCommand[]>([]),
    [requests, setRequests] = useState<OwnerRequest[]>([]),
    [sources, setSources] = useState<Data[]>([]),
    [hasMore, setHasMore] = useState(false),
    [batch, setBatch] = useState(0),
    [prompt, setPrompt] = useState(() => sessionStorage.getItem("prompt:" + session.id) ?? ""),
    [assets, setAssets] = useState<Data[]>([]),
    [error, setError] = useState(""),
    { busy, error: actionError, run } = useAction(),
    cursor = useRef(0),
    contentRevision = useRef(0);
  const [lastDeletedAt, setLastDeletedAt] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refetch on server invalidation or requested pagination.
  useEffect(() => {
    let active = true;
    void Promise.all([
      call<{ runtime: SessionRuntime | null; checkout: CheckoutObservation | null }>(
        "session_runtime_get",
        {
          target_session_id: session.id,
        },
      ),
      call<{
        items: SessionEvent[];
        has_more: boolean;
        next_sequence: number;
        content_revision: number;
        last_deleted_at: string | null;
      }>("session_transcript_events", {
        target_session_id: session.id,
        after: cursor.current,
        limit: 200,
      }),
      call<Page<SessionCommand>>("session_commands", { target_session_id: session.id, limit: 100 }),
      call<OwnerRequest[]>("session_requests", { target_session_id: session.id }),
      call<Data[]>("session_transcript_sources", { target_session_id: session.id }),
    ])
      .then(async ([r, e, c, q, s]) => {
        const reset = e.content_revision !== contentRevision.current;
        if (reset)
          e = await call<typeof e>("session_transcript_events", {
            target_session_id: session.id,
            after: 0,
            limit: 200,
          });
        if (!active) return;
        setRuntime(r.runtime);
        setCheckout(r.checkout);
        contentRevision.current = e.content_revision;
        setLastDeletedAt(e.last_deleted_at);
        setEvents((previous) => {
          const old = reset ? [] : previous;
          return [...old, ...e.items.filter((item) => !old.some((o) => o.id === item.id))];
        });
        cursor.current = e.next_sequence;
        setHasMore(e.has_more);
        setCommands(c.items);
        setRequests(q);
        setSources(s);
        setError("");
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [session.id, refresh, batch]);
  const rendered: { key: string; role: string; at: string; content: unknown; detail?: unknown }[] =
    [];
  const echoed = new Set(
    events
      .filter((e) =>
        ["user_message", "user_message_chunk"].includes(String(e.payload.sessionUpdate ?? e.kind)),
      )
      .map((e) => e.command_id),
  );
  for (const command of commands.filter(
    (c) =>
      c.kind === "prompt" && !echoed.has(c.id) && (!lastDeletedAt || c.created_at > lastDeletedAt),
  ))
    rendered.push({
      key: command.id,
      role: `You · ${command.state}`,
      at: command.created_at,
      content: command.payload.content,
    });
  for (const e of events) {
    const payload = (
        e.payload.update && typeof e.payload.update === "object" ? e.payload.update : e.payload
      ) as Data,
      type = String(payload.sessionUpdate ?? e.kind),
      role = type.includes("user_message")
        ? "User"
        : type.includes("agent_message")
          ? "Agent"
          : type.includes("tool_call")
            ? "Tool"
            : type === "gap"
              ? "Missing history"
              : type;
    const rawContent = payload.content ?? payload.text ?? payload.message;
    const content =
      rawContent && typeof rawContent === "object" && (rawContent as Data).type === "text"
        ? String((rawContent as Data).text ?? "")
        : rawContent;
    const previous = rendered.at(-1);
    if (
      type.endsWith("_message_chunk") &&
      previous?.role === role &&
      typeof previous.content === "string" &&
      (typeof content === "string" || (content as Data)?.type === "text")
    )
      previous.content +=
        typeof content === "string" ? content : String((content as Data).text ?? "");
    else
      rendered.push({
        key: e.id,
        role,
        at: e.received_at,
        content: content ?? null,
        detail: content === undefined ? payload : undefined,
      });
  }
  rendered.sort((a, b) => a.at.localeCompare(b.at));
  const live =
    !!runtime &&
    runtime.connected &&
    !runtime.fenced &&
    !["ended", "error"].includes(runtime.state);
  const machine = runtime ? machines.find((m) => m.id === runtime.machine_id) : null;
  const controls =
    runtime &&
    (runtime.protocol === "terminal" ? terminalAvailable(machine) : managedAvailable(machine))
      ? intersectControls(
          runtime.controls,
          runtime.protocol === "terminal"
            ? machine?.terminal_controls[session.agent_type]
            : machine?.harness_controls[session.agent_type],
        )
      : null;
  const canPrompt = !!controls?.capabilities.includes("prompt") && !runtime?.stop_requested;
  const forceResume = !!runtime?.resume_requires_force;
  const canResume =
    !!runtime &&
    !!controls?.capabilities.includes("resume") &&
    !!machine?.connected &&
    machine.capabilities.includes("session-resume.v1") &&
    (forceResume
      ? machine.capabilities.includes("session-force-resume.v1")
      : ["ended", "error"].includes(runtime.state));
  return (
    <section className="session-detail">
      <div className="section-line">
        <div>
          <h2>{session.label ?? session.id}</h2>
          <ContextLink id={session.id} />
          {runtime && (
            <p className="muted small">
              {machines.find((m) => m.id === runtime.machine_id)?.name ?? runtime.machine_id} ·{" "}
              {runtime.cwd}
            </p>
          )}
          {runtime?.checkout_id && (
            <p className="muted small session-checkout">
              Checkout <code>{runtime.checkout_id}</code> ·{" "}
              {checkout ? (
                <>
                  {checkout.path}
                  {!checkout.present
                    ? " · Removed"
                    : !checkout.available
                      ? " · Unavailable"
                      : !checkout.connected
                        ? " · Observation stale"
                        : ""}
                </>
              ) : (
                "Awaiting checkout observation"
              )}
            </p>
          )}
          <p className="muted small">
            {session.agent_type} ·{" "}
            {runtime
              ? `${runtime.state}${runtime.connected ? "" : " · disconnected"}`
              : "Stored history"}
          </p>
        </div>
        {runtime &&
          controls?.cancel_mode &&
          !runtime.stop_requested &&
          !["ended", "error"].includes(runtime.state) && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call("session_cancel", { target_session_id: session.id, ...mutation() });
                  changed();
                })
              }
            >
              {controls.cancel_mode === "runtime"
                ? "Stop runtime and queued work"
                : "Stop queued and current work"}
            </button>
          )}
        {canResume && runtime && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await call("session_resume", {
                  target_session_id: session.id,
                  machine_id: runtime.machine_id,
                  cwd: runtime.cwd,
                  ...(forceResume ? { force: true } : {}),
                  ...mutation(),
                });
                changed();
              })
            }
          >
            {forceResume ? "Clean up and resume" : "Resume session"}
          </button>
        )}
      </div>
      <ErrorText>{error || actionError}</ErrorText>
      {canResume && forceResume && (
        <p className="notice">
          Clean up and resume stops the previous execution before starting a replacement. Current
          work is interrupted; stored conversation history is retained.
        </p>
      )}
      {controls?.cancel_mode === "runtime" &&
        !["ended", "error"].includes(runtime?.state ?? "") && (
          <p className="notice">
            {runtime?.stop_requested
              ? "Stopping this runtime. New work is blocked until termination is confirmed."
              : runtime?.protocol === "terminal"
                ? "Stopping this terminal ends its runtime. Remote resume is not supported."
                : "Stopping this agent ends its runtime. Continuing requires an explicit resume; Allgather will not restart it automatically."}
          </p>
        )}
      {runtime &&
        controls &&
        (!controls.capabilities.includes("permission_reply") ||
          !controls.capabilities.includes("configure")) && (
          <p className="muted small">
            {!controls.capabilities.includes("permission_reply") &&
              "Live permission replies are unavailable for this execution. "}
            {!controls.capabilities.includes("configure") &&
              "Live configuration changes are unavailable."}
          </p>
        )}
      {runtime?.protocol === "terminal" && (
        <p className="notice">
          This is a terminal session. Allgather stores lifecycle metadata, not terminal output.
          Prompts, permission replies, configuration, and resume are unavailable.
          {runtime.tower_session_id && (
            <>
              <br />
              On {machine?.name ?? "the development machine"}:{" "}
              <code>tower-cli attach {runtime.tower_session_id}</code>
            </>
          )}
        </p>
      )}
      {runtime?.fenced && runtime.termination === "unknown" && (
        <p className="notice">
          Contact with this execution was lost. Its process may still run. Controls are disabled,
          {runtime.protocol === "terminal"
            ? " Inspect or stop the terminal with Tower; remote replacement is unavailable."
            : " and force resume must confirm cleanup before starting a replacement."}
        </p>
      )}
      <div className="session-coverage">
        {sources.length ? (
          sources.map((s) => (
            <small key={String(s.id)}>
              {String(s.kind).replaceAll("_", " ")} · {String(s.coverage)} coverage
            </small>
          ))
        ) : (
          <small>No transcript events recorded yet.</small>
        )}
      </div>
      {requests
        .filter((q) => q.state === "pending")
        .map((q) => (
          <RequestCard
            key={q.id}
            item={q}
            live={
              live &&
              !runtime?.stop_requested &&
              !!controls?.capabilities.includes(
                q.kind === "permission" ? "permission_reply" : "elicitation_reply",
              ) &&
              q.runtime_generation === runtime?.generation
            }
            send={async (response) => {
              await call("session_reply", {
                request_id: q.id,
                expected_revision: q.revision,
                response,
                ...mutation(),
              });
              changed();
            }}
          />
        ))}
      <TranscriptStorage sessionId={session.id} changed={changed} />
      <section className="transcript" aria-label="Session transcript">
        {rendered.map((row) => (
          <article className="transcript-message" key={row.key}>
            <strong>{row.role}</strong>
            <small>{new Date(row.at).toLocaleString()}</small>
            <div className="message-content">
              <Content value={row.content} />
            </div>
            {row.detail !== undefined && (
              <details>
                <summary>Details</summary>
                <pre>{JSON.stringify(row.detail, null, 2)}</pre>
              </details>
            )}
          </article>
        ))}
        {hasMore && (
          <button type="button" onClick={() => setBatch((b) => b + 1)}>
            Load more history
          </button>
        )}
      </section>
      {runtime &&
        canPrompt &&
        (runtime.acp_session_id || runtime.native_session_id) &&
        !runtime.fenced &&
        runtime.state !== "starting" &&
        !["ended", "error"].includes(runtime.state) && (
          <form
            className="session-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await call("session_prompt", {
                  target_session_id: session.id,
                  content: [
                    { type: "text", text: prompt },
                    ...assets.map((a) => ({
                      type: String(a.media_type).startsWith("image/") ? "image" : "resource_link",
                      asset_id: a.id,
                      mimeType: a.media_type,
                      name: a.name,
                    })),
                  ],
                  ...mutation(),
                });
                setPrompt("");
                sessionStorage.removeItem("prompt:" + session.id);
                setAssets([]);
                changed();
              });
            }}
          >
            <label>
              Message
              <textarea
                rows={4}
                required={!assets.length}
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  sessionStorage.setItem("prompt:" + session.id, e.target.value);
                }}
                placeholder={
                  runtime.connected
                    ? "Ask the agent to continue…"
                    : "Your message will wait for reconnection."
                }
              />
            </label>
            <div className="heading-actions">
              <label className="file-control">
                Attach file
                <input
                  type="file"
                  disabled={
                    busy ||
                    !controls?.capabilities.some((c) =>
                      ["image_input", "resource_input"].includes(c),
                    )
                  }
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void run(async () => {
                      if (file.size > 20 * 1024 * 1024)
                        throw new Error("Files must be at most 20 MiB");
                      if (
                        !controls?.capabilities.includes(
                          file.type.startsWith("image/") ? "image_input" : "resource_input",
                        )
                      )
                        throw new Error("This agent does not support that attachment type");
                      const bytes = new Uint8Array(await file.arrayBuffer());
                      let binary = "";
                      for (let i = 0; i < bytes.length; i += 8192)
                        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                      const asset = await call<Data>("session_assets_add", {
                        target_session_id: session.id,
                        name: file.name,
                        media_type: file.type || "application/octet-stream",
                        data: btoa(binary),
                        ...mutation(),
                      });
                      setAssets((old) => [...old, asset]);
                    });
                  }}
                />
              </label>
              {assets.map((a) => (
                <small key={String(a.id)}>{String(a.name)}</small>
              ))}
              <button
                type="submit"
                className="primary"
                disabled={busy || (!prompt.trim() && !assets.length)}
              >
                Send
              </button>
            </div>
          </form>
        )}
      <details className="detail-section">
        <summary>Command delivery</summary>
        {commands.map((c) => {
          const receipt = c.result as {
            state?: string;
            acceptance?: { level: string };
            dispatch?: { state: string };
          } | null;
          return (
            <div className="command-row" key={c.id}>
              <strong>
                {c.kind} · {c.state}
              </strong>
              {receipt?.acceptance && (
                <p>
                  Accepted by the {receipt.acceptance.level}. Dispatch:{" "}
                  {receipt.dispatch?.state ?? "unknown"}. Turn completion is recorded separately.
                </p>
              )}
              {c.state === "unknown" && (
                <p className="notice">
                  Acceptance is unknown. Allgather will query Tower’s receipt and will not resend
                  this command automatically.
                </p>
              )}
              {c.result !== null && <pre>{JSON.stringify(c.result, null, 2)}</pre>}
            </div>
          );
        })}
      </details>
    </section>
  );
}
function MachineManager({
  machines,
  close,
  changed,
}: {
  machines: Machine[];
  close: () => void;
  changed: () => void;
}) {
  const [keys, setKeys] = useState<
      { id: string; machine_id: string; label: string; revoked_at: string | null }[]
    >([]),
    { busy, error, run } = useAction();
  useEffect(() => {
    void run(async () => setKeys(await request("/api/tower/credentials")));
  }, [run]);
  return (
    <Dialog title="Development machines" close={close}>
      <TowerPairing machines={machines} changed={changed} />
      <ErrorText>{error}</ErrorText>
      <ul className="plain-list">
        {machines.map((m) => (
          <li key={m.id}>
            <span>
              <strong>{m.name}</strong>
              <small>
                {m.connected ? "Connected" : "Offline"} ·{" "}
                {managedAvailable(m) && m.harnesses.some((h) => !!m.harness_controls[h])
                  ? "Managed sessions available"
                  : "Managed sessions are not available"}
              </small>
              <small>
                {terminalAvailable(m) && Object.keys(m.terminal_controls).length
                  ? "Terminal launch available"
                  : "Terminal launch is not available"}
              </small>
              <small>
                {m.policy_status === "applied"
                  ? `Policy ${m.policy_report?.applied_revision} applied`
                  : m.policy_status === "rejected"
                    ? `Policy ${m.policy_revision} rejected: ${m.policy_report?.reason ?? "review the policy"}`
                    : `Policy ${m.policy_revision} pending`}
              </small>
            </span>
          </li>
        ))}
      </ul>
      <h3>Access keys</h3>
      {keys.map((k) => (
        <div className="section-line" key={k.id}>
          <span>
            {machines.find((m) => m.id === k.machine_id)?.name ?? k.machine_id} · {k.label}
          </span>
          {k.revoked_at ? (
            <small>Revoked</small>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await request(`/api/tower/credentials/${k.id}/revoke`, {});
                  setKeys(await request("/api/tower/credentials"));
                  changed();
                })
              }
            >
              Revoke
            </button>
          )}
        </div>
      ))}
    </Dialog>
  );
}
export function SessionsView({
  project,
  refresh,
  changed,
}: {
  project: string;
  refresh: number;
  changed: () => void;
}) {
  const [page, setPage] = useState<Page<AgentSession>>({ items: [], total: 0, next_cursor: null }),
    [machines, setMachines] = useState<Machine[]>([]),
    [roles, setRoles] = useState<Role[]>([]),
    [selected, setSelected] = useState(new URLSearchParams(location.search).get("session") ?? ""),
    [query, setQuery] = useState(""),
    [taskFilter, setTaskFilter] = useState(""),
    [machineFilter, setMachineFilter] = useState(""),
    [since, setSince] = useState(""),
    [until, setUntil] = useState(""),
    [selectedRecord, setSelectedRecord] = useState<AgentSession | null>(null),
    [cursor, setCursor] = useState(0),
    [manage, setManage] = useState(false),
    [launch, setLaunch] = useState(false),
    [launchMode, setLaunchMode] = useState<"managed" | "terminal">("managed"),
    [machine, setMachine] = useState(""),
    [harness, setHarness] = useState(""),
    [cwd, setCwd] = useState(""),
    [role, setRole] = useState(""),
    [label, setLabel] = useState(""),
    [newRole, setNewRole] = useState(""),
    [loadError, setLoadError] = useState(""),
    { busy, error, run } = useAction();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh counters reload committed server state.
  useEffect(() => {
    let live = true;
    void Promise.all([
      call<Page<AgentSession>>("sessions_search", {
        query,
        cursor,
        project_id: project || undefined,
        task_id: taskFilter || undefined,
        machine_id: machineFilter || undefined,
        since: since ? new Date(since).toISOString() : undefined,
        until: until ? new Date(until).toISOString() : undefined,
      }),
      call<Machine[]>("machines_list"),
      call<Role[]>("roles_list"),
    ])
      .then(([s, m, r]) => {
        if (live) {
          setPage(s);
          setMachines(m);
          setRoles(r);
          setLoadError("");
        }
      })
      .catch((e) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [query, cursor, refresh, project, taskFilter, machineFilter, since, until]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Keep direct session links and current selection independent of result-page membership.
  useEffect(() => {
    let active = true;
    if (!selected) {
      setSelectedRecord(null);
      return;
    }
    void call<AgentSession>("sessions_get", { target_session_id: selected })
      .then((s) => {
        if (active) setSelectedRecord(s);
      })
      .catch((e) => active && setLoadError(e.message));
    return () => {
      active = false;
    };
  }, [selected, refresh]);
  const selectSession = (id: string) => {
    setSelected(id);
    const url = new URL(location.href);
    url.searchParams.set("session", id);
    history.replaceState(null, "", url);
  };
  const current =
      page.items.find((s) => s.id === selected) ??
      (selectedRecord?.id === selected ? selectedRecord : null),
    chosen = machines.find((m) => m.id === machine),
    supported = launchMode === "terminal" ? terminalAvailable(chosen) : managedAvailable(chosen),
    launchControls =
      launchMode === "terminal" ? chosen?.terminal_controls : chosen?.harness_controls;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Sessions</h1>
          <p>Read past work and run agents on your development machines.</p>
        </div>
        <div className="heading-actions">
          <TranscriptStorage changed={changed} />
          <button type="button" onClick={() => setManage(true)}>
            Machines
          </button>
          <button type="button" className="primary" onClick={() => setLaunch(true)}>
            New session
          </button>
        </div>
      </div>
      <ErrorText>{loadError || error}</ErrorText>
      <details className="filter-details">
        <summary>Filter sessions</summary>
        <div className="filter-grid">
          <label>
            Task ID
            <input
              value={taskFilter}
              onChange={(e) => {
                setTaskFilter(e.target.value);
                setCursor(0);
              }}
              placeholder="Any task"
            />
          </label>
          <label>
            Has run on
            <select
              value={machineFilter}
              onChange={(e) => {
                setMachineFilter(e.target.value);
                setCursor(0);
              }}
            >
              <option value="">Any machine</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Created since
            <input
              type="datetime-local"
              value={since}
              onChange={(e) => {
                setSince(e.target.value);
                setCursor(0);
              }}
            />
          </label>
          <label>
            Created before
            <input
              type="datetime-local"
              value={until}
              onChange={(e) => {
                setUntil(e.target.value);
                setCursor(0);
              }}
            />
          </label>
        </div>
      </details>
      <div className="session-layout">
        <section className="session-list">
          <label className="search">
            <span className="sr-only">Search sessions</span>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              placeholder="Search sessions"
            />
          </label>
          {page.items.map((s) => (
            <button
              type="button"
              className={`task-row ${selected === s.id ? "selected" : ""}`}
              key={s.id}
              onClick={() => selectSession(s.id)}
            >
              <span>
                <strong>{s.label ?? s.id}</strong>
                <small>
                  {s.agent_type}
                  {s.role_id
                    ? ` · ${roles.find((r) => r.id === s.role_id)?.name ?? s.role_id}`
                    : ""}
                </small>
              </span>
            </button>
          ))}
          {!page.items.length && (
            <p className="empty-copy">Declared agent runs and imported history appear here.</p>
          )}
          <div className="pagination">
            <button
              type="button"
              disabled={!cursor}
              onClick={() => setCursor(Math.max(0, cursor - 50))}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page.next_cursor === null}
              onClick={() => setCursor(page.next_cursor ?? 0)}
            >
              Next
            </button>
          </div>
        </section>
        {current ? (
          <SessionDetail
            key={current.id}
            session={current}
            machines={machines}
            refresh={refresh}
            changed={changed}
          />
        ) : (
          <section className="empty">
            <h2>Select a session</h2>
            <p>Stored transcripts remain readable while a machine is offline.</p>
          </section>
        )}
      </div>
      {manage && (
        <MachineManager machines={machines} close={() => setManage(false)} changed={changed} />
      )}{" "}
      {launch && (
        <Dialog title="New agent session" close={() => setLaunch(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await call<{ session: AgentSession }>("session_launch", {
                  machine_id: machine,
                  project_id: project || undefined,
                  harness,
                  mode: launchMode,
                  cwd,
                  role_id: role || undefined,
                  label: label || undefined,
                  ...mutation(),
                });
                selectSession(result.session.id);
                setLaunch(false);
                changed();
              });
            }}
          >
            <label>
              Machine
              <select
                required
                value={machine}
                onChange={(e) => {
                  setMachine(e.target.value);
                  setHarness("");
                }}
              >
                <option value="">Choose a machine</option>
                {machines.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.name}
                    {m.connected ? "" : " · offline"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Session mode
              <select
                value={launchMode}
                onChange={(e) => {
                  setLaunchMode(e.target.value as "managed" | "terminal");
                  setHarness("");
                }}
              >
                <option value="managed">Managed agent</option>
                <option value="terminal">Terminal</option>
              </select>
            </label>
            {chosen && !supported && (
              <p className="notice">
                {launchMode === "terminal"
                  ? "Terminal launch requires a connected Tower with terminal support and explicit terminal:control consent."
                  : "Managed sessions are not enabled for this connection."}
              </p>
            )}
            <label>
              Agent
              <select required value={harness} onChange={(e) => setHarness(e.target.value)}>
                <option value="">Choose an agent</option>
                {Object.keys(launchControls ?? {}).map((h) => (
                  <option value={h} key={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            {launchControls?.[harness]?.cancel_mode === "runtime" && (
              <p className="notice">
                {launchMode === "terminal"
                  ? "This starts a terminal immediately. Attach with Tower on the development machine. Remote prompt and resume are unavailable."
                  : "Stopping this agent terminates its runtime. Resume requires a new explicit action."}
              </p>
            )}
            <label>
              Working directory
              <input
                required
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/work/project"
              />
            </label>
            <label>
              Session label
              <input value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">No role</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <ErrorText>{error}</ErrorText>
            <button
              type="submit"
              className="primary"
              disabled={busy || !supported || !launchControls?.[harness]}
            >
              Start session
            </button>
          </form>
          <details className="detail-section">
            <summary>Create a role</summary>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const created = await call<Role>("roles_create", {
                    name: newRole,
                    ...mutation(),
                  });
                  setRoles((old) => [...old, created]);
                  setRole(created.id);
                  setNewRole("");
                  changed();
                });
              }}
            >
              <input
                aria-label="New role name"
                required
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
              />
              <button type="submit" disabled={busy}>
                Create role
              </button>
            </form>
          </details>
        </Dialog>
      )}
    </>
  );
}
