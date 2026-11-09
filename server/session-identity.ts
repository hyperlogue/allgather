import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { AgentSession } from "../shared/contracts.ts";

type Row = AgentSession & {
  merged_into: string | null;
  native_provider: string | null;
  timeline_revision: number;
};
export function sessionProvider(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (!name || name.length > 160 || name === "unknown") return null;
  return (
    (
      {
        "claude-code": "claude",
        claude_code: "claude",
        "codex-app-server": "codex",
        agy: "antigravity",
      } as Record<string, string>
    )[name] ?? name
  );
}
export function inferredSessionIdentity(id: string, harness?: string) {
  const known = /^(codex|claude|claude-code|antigravity|agy):(.+)$/i.exec(id);
  const provider = known ? sessionProvider(known[1]) : sessionProvider(harness);
  if (
    !provider ||
    (known && harness && sessionProvider(harness) && sessionProvider(harness) !== provider)
  )
    return null;
  const prefix = known
    ? known[1]
    : [harness, provider].find(
        (name) => name && id.toLowerCase().startsWith(`${name.toLowerCase()}:`),
      );
  if (!prefix) return null;
  const native = id.slice(prefix.length + 1);
  return native && native.length <= 160 ? { provider, native_id: native } : null;
}
export function resolveSession(db: Database, id: string): string {
  const alias = db.query("SELECT session_id FROM session_aliases WHERE alias=?").get(id) as {
    session_id: string;
  } | null;
  const row = db
    .query("SELECT id,merged_into FROM agent_sessions WHERE id=?")
    .get(alias?.session_id ?? id) as { id: string; merged_into: string | null } | null;
  if (row) return row.merged_into ?? row.id;
  const native = inferredSessionIdentity(id);
  return (
    (native
      ? (db
          .query("SELECT session_id FROM session_identities WHERE provider=? AND native_id=?")
          .get(native.provider, native.native_id) as { session_id: string } | null)
      : null
    )?.session_id ?? id
  );
}
export interface SessionIdentityWarning {
  id: string;
  field: string;
  message: string;
  values: unknown[];
  session_ids: string[];
  created_at: string;
}
export class SessionIdentity {
  constructor(
    private db: Database,
    private now: () => string,
    private authorize: (id: string) => void,
  ) {}
  resolve(id: string) {
    return resolveSession(this.db, id);
  }
  members(id: string): Row[] {
    return this.db
      .query("SELECT * FROM agent_sessions WHERE id=? OR merged_into=? ORDER BY created_at,id")
      .all(this.resolve(id), this.resolve(id)) as Row[];
  }
  physical(id: string) {
    if (this.db.query("SELECT 1 FROM agent_sessions WHERE id=?").get(id)) return id;
    return (
      (
        this.db.query("SELECT session_id FROM session_alias_origins WHERE alias=?").get(id) as {
          session_id: string;
        } | null
      )?.session_id ?? this.resolve(id)
    );
  }
  warn(id: string, field: string, message: string, values: unknown[], sessions: string[]) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([field, values, sessions.slice().sort()]))
      .digest("hex");
    this.db
      .query(
        "INSERT OR IGNORE INTO session_identity_warnings(id,session_id,fingerprint,field,message,body,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        `identity-warning-${randomUUID()}`,
        this.resolve(id),
        fingerprint,
        field,
        message,
        JSON.stringify({ values, session_ids: sessions }),
        this.now(),
      );
  }
  warnings(id: string): SessionIdentityWarning[] {
    return (
      this.db
        .query(
          "SELECT id,field,message,body,created_at FROM session_identity_warnings WHERE session_id IN (SELECT member_id FROM session_members WHERE session_id=?) GROUP BY fingerprint ORDER BY created_at,id",
        )
        .all(this.resolve(id)) as {
        id: string;
        field: string;
        message: string;
        body: string;
        created_at: string;
      }[]
    ).map(({ body, ...row }) => ({ ...row, ...JSON.parse(body) }));
  }
  register(id: string, providerInput: string, nativeId: string): string {
    const provider = sessionProvider(providerInput);
    if (!nativeId || nativeId.length > 160) return this.resolve(id);
    if (!provider) {
      const canonical = this.resolve(id),
        physical = this.physical(id);
      this.authorize(canonical);
      const old = this.db
        .query("SELECT native_session_id FROM agent_sessions WHERE id=?")
        .get(physical) as { native_session_id: string | null };
      if (!old.native_session_id)
        this.db
          .query("UPDATE agent_sessions SET native_session_id=? WHERE id=?")
          .run(nativeId, physical);
      else if (old.native_session_id !== nativeId)
        this.warn(
          canonical,
          "native_identity",
          "Native identity metadata disagrees with this observation.",
          [old.native_session_id, nativeId],
          [physical],
        );
      return canonical;
    }
    return this.db
      .transaction(() => {
        const current = this.resolve(id);
        this.authorize(current);
        const existing = this.db
          .query("SELECT provider,native_id FROM session_identities WHERE session_id=?")
          .get(current) as { provider: string; native_id: string } | null;
        if (existing && (existing.provider !== provider || existing.native_id !== nativeId)) {
          this.warn(
            current,
            "native_identity",
            "Conflicting native identity was retained as a warning; the established identity was not replaced.",
            [existing, { provider, native_id: nativeId }],
            [id],
          );
          return current;
        }
        const match = this.db
          .query("SELECT session_id FROM session_identities WHERE provider=? AND native_id=?")
          .get(provider, nativeId) as { session_id: string } | null;
        const canonical = match?.session_id ?? current;
        this.authorize(canonical);
        const physical = this.physical(id);
        const old = this.db
          .query("SELECT native_session_id FROM agent_sessions WHERE id=?")
          .get(physical) as { native_session_id: string | null };
        if (old.native_session_id && old.native_session_id !== nativeId) {
          this.warn(
            current,
            "native_identity",
            "Native identity metadata disagrees with this observation.",
            [old.native_session_id, nativeId],
            [physical],
          );
          return current;
        }
        this.db
          .query(
            "UPDATE agent_sessions SET native_provider=?,native_session_id=?,updated_at=? WHERE id=? AND (native_provider IS NOT ? OR native_session_id IS NOT ?)",
          )
          .run(provider, nativeId, this.now(), physical, provider, nativeId);
        if (canonical !== current) this.merge(canonical, current);
        this.db
          .query(
            "INSERT OR IGNORE INTO session_identities(provider,native_id,session_id) VALUES(?,?,?)",
          )
          .run(provider, nativeId, canonical);
        this.conflicts(canonical);
        return canonical;
      })
      .immediate();
  }
  enrich(
    id: string,
    metadata: {
      harness?: string;
      label?: string;
      project_id?: string;
      role_id?: string;
      source_namespace?: string;
    },
  ) {
    const physical = this.physical(id),
      canonical = this.resolve(id);
    this.authorize(canonical);
    const row = this.db.query("SELECT * FROM agent_sessions WHERE id=?").get(physical) as Row;
    if (metadata.project_id)
      this.db
        .query("INSERT OR IGNORE INTO session_project_scopes VALUES(?,?)")
        .run(physical, metadata.project_id);
    for (const field of ["label", "project_id", "role_id", "source_namespace"] as const) {
      const value = metadata[field];
      if (value === undefined) continue;
      if (field === "label" && !this.meaningful({ ...row, label: value })) continue;
      if (!row[field] || (field === "label" && !this.meaningful(row))) {
        this.db
          .query(`UPDATE agent_sessions SET ${field}=?,revision=revision+1,updated_at=? WHERE id=?`)
          .run(value, this.now(), physical);
      } else if (row[field] !== value) {
        this.warn(
          canonical,
          field,
          `Session observations have different ${field.replaceAll("_", " ")} values. The established value was retained.`,
          [row[field], value],
          [physical],
        );
      }
    }
    if (row.agent_type === "unknown" && metadata.harness && metadata.harness !== "unknown")
      this.db
        .query("UPDATE agent_sessions SET agent_type=?,revision=revision+1,updated_at=? WHERE id=?")
        .run(metadata.harness, this.now(), physical);
    this.conflicts(canonical);
  }
  runtimeNamespaces(id: string) {
    return (
      this.db
        .query(
          "SELECT DISTINCT r.session_id FROM session_runtimes r JOIN session_members m ON m.member_id=r.session_id WHERE m.session_id=? AND (r.termination!='confirmed' OR r.state NOT IN ('ended','error'))",
        )
        .all(this.resolve(id)) as { session_id: string }[]
    ).map((row) => row.session_id);
  }
  private merge(canonical: string, other: string) {
    const revision = this.db
      .query("SELECT MAX(timeline_revision) n FROM agent_sessions WHERE id IN (?,?)")
      .get(canonical, other) as { n: number };
    const deletion = this.db
      .query(
        "SELECT COALESCE(MAX(sequence),0) n FROM transcript_deletions WHERE session_id IN (SELECT member_id FROM session_members WHERE session_id IN (?,?))",
      )
      .get(canonical, other) as { n: number };
    const offset = this.db
      .query("SELECT COALESCE(MAX(sequence),0) n FROM session_timeline WHERE session_id=?")
      .get(canonical) as { n: number };
    this.db
      .query("UPDATE session_timeline SET session_id=?,sequence=sequence+? WHERE session_id=?")
      .run(canonical, offset.n, other);
    this.db
      .query("UPDATE session_aliases SET session_id=? WHERE session_id=?")
      .run(canonical, other);
    this.db
      .query(
        "INSERT INTO session_aliases(alias,session_id) VALUES(?,?) ON CONFLICT(alias) DO UPDATE SET session_id=excluded.session_id",
      )
      .run(other, canonical);
    this.db
      .query("UPDATE agent_sessions SET merged_into=? WHERE id=? OR merged_into=?")
      .run(canonical, other, other);
    this.db
      .query("UPDATE session_identities SET session_id=? WHERE session_id=?")
      .run(canonical, other);
    this.db
      .query(
        "UPDATE agent_sessions SET revision=revision+1,timeline_revision=?,updated_at=? WHERE id=?",
      )
      .run(revision.n + deletion.n + 1, this.now(), canonical);
  }
  private meaningful(row: Row) {
    return (
      !!row.label &&
      row.label !== row.id &&
      (!row.native_session_id ||
        inferredSessionIdentity(row.label, row.agent_type)?.native_id !== row.native_session_id)
    );
  }
  private conflicts(id: string) {
    const rows = this.members(id);
    for (const field of ["label", "role_id", "project_id"] as const) {
      const present = rows.filter((row) =>
        field === "label" ? this.meaningful(row) : row[field] !== null,
      );
      const values =
        field === "project_id"
          ? (
              this.db
                .query(
                  "SELECT DISTINCT project_id FROM session_project_scopes WHERE project_id IS NOT NULL AND session_id IN (SELECT member_id FROM session_members WHERE session_id=?) ORDER BY project_id",
                )
                .all(id) as { project_id: string }[]
            ).map((row) => row.project_id)
          : [...new Set(present.map((row) => row[field]))];
      if (values.length > 1)
        this.warn(
          id,
          field,
          `Merged session records have different ${field.replaceAll("_", " ")} values. Original values are retained.`,
          values,
          present.map((row) => row.id),
        );
    }
    const sources = this.db
      .query(
        "SELECT kind,source_key,group_concat(id) ids,COUNT(*) n FROM transcript_sources WHERE session_id IN (SELECT member_id FROM session_members WHERE session_id=?) GROUP BY kind,source_key HAVING COUNT(*)>1",
      )
      .all(id) as { kind: string; source_key: string; ids: string; n: number }[];
    for (const source of sources)
      this.warn(
        id,
        "transcript_source",
        "Overlapping transcript sources were preserved separately; no captured history was discarded.",
        [{ kind: source.kind, source_key: source.source_key, source_ids: source.ids.split(",") }],
        rows.map((row) => row.id),
      );
  }
  describe(id: string): AgentSession | null {
    const canonical = this.resolve(id),
      rows = this.members(canonical),
      row = rows.find((row) => row.id === canonical);
    if (!row) return null;
    const native = this.db
      .query("SELECT provider,native_id FROM session_identities WHERE session_id=?")
      .get(canonical) as { provider: string; native_id: string } | null;
    const managed = this.db
      .query(
        "SELECT s.agent_type FROM session_runtimes r JOIN agent_sessions s ON s.id=r.session_id WHERE r.session_id IN (SELECT member_id FROM session_members WHERE session_id=?) ORDER BY CASE WHEN r.termination!='confirmed' THEN 0 ELSE 1 END,r.rowid DESC LIMIT 1",
      )
      .get(canonical) as { agent_type: string } | null;
    const { merged_into: _merged, timeline_revision: _timeline, ...base } = row;
    return {
      ...base,
      agent_type: managed?.agent_type ?? row.agent_type,
      label:
        (this.meaningful(row) ? row : rows.find((r) => this.meaningful(r)))?.label ?? row.label,
      source_namespace:
        row.source_namespace ?? rows.find((r) => r.source_namespace)?.source_namespace ?? null,
      role_id: row.role_id ?? rows.find((r) => r.role_id)?.role_id ?? null,
      project_id: row.project_id ?? rows.find((r) => r.project_id)?.project_id ?? null,
      native_provider: native?.provider ?? row.native_provider,
      native_session_id: native?.native_id ?? row.native_session_id,
      aliases: [
        ...new Set([
          ...rows.map((r) => r.id),
          ...(
            this.db
              .query("SELECT alias FROM session_aliases WHERE session_id=?")
              .all(canonical) as { alias: string }[]
          ).map((r) => r.alias),
        ]),
      ].filter((x) => x !== canonical),
      identity_warnings: [
        ...this.warnings(canonical),
        ...(this.runtimeNamespaces(canonical).length > 1
          ? [
              {
                id: "ambiguous-execution",
                field: "execution",
                message:
                  "Merged records have unresolved executions in different control namespaces. Session controls are disabled until those executions are stopped through Tower.",
                values: this.runtimeNamespaces(canonical),
                session_ids: rows.map((r) => r.id),
                created_at: row.updated_at,
              },
            ]
          : []),
      ],
      project_ids: (
        this.db
          .query(
            "SELECT DISTINCT project_id FROM session_project_scopes WHERE session_id IN (SELECT member_id FROM session_members WHERE session_id=?) ORDER BY project_id",
          )
          .all(canonical) as { project_id: string | null }[]
      ).map((r) => r.project_id),
      observations: this.db
        .query(
          "SELECT l.machine_id,l.tower_id,t.record FROM session_tower_links l LEFT JOIN tower_records t ON t.machine_id=l.machine_id AND t.tower_id=l.tower_id WHERE l.session_id IN (SELECT member_id FROM session_members WHERE session_id=?) ORDER BY l.machine_id,l.tower_id",
        )
        .all(canonical)
        .map((raw) => {
          const r = raw as { machine_id: string; tower_id: string; record: string | null };
          const record = r.record ? JSON.parse(r.record) : null;
          return {
            ...r,
            record:
              record &&
              sessionProvider(record.harness) === (native?.provider ?? row.native_provider) &&
              record.native_session_id === (native?.native_id ?? row.native_session_id)
                ? record
                : null,
          };
        }),
    };
  }
}
