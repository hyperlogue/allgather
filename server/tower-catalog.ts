import type { ServerWebSocket } from "bun";
import { AppError } from "../shared/contracts.ts";
import {
  type CheckoutObservation,
  catalogAckSchema,
  catalogSchema,
  checkoutDeltaSchema,
  checkoutSnapshotSchema,
  type RepositoryCatalog,
  resyncSchema,
  type TowerCheckout,
} from "../shared/tower-catalog.ts";
import { remoteUrl } from "./native-git.ts";
import type { TowerSocketData } from "./tower.ts";
import { canonical, digest, uid, type Workspace } from "./workspace.ts";

type Socket = ServerWebSocket<TowerSocketData>;
type Frame = { jsonrpc: "2.0"; id?: string; method: string; params: unknown };
export interface CatalogConnection {
  acknowledged: RepositoryCatalog | null;
  pending: { frame: Frame; catalog: RepositoryCatalog; sentAt: number } | null;
  forceFull: boolean;
  blockedRevision: number | null;
  checkoutSeq: number;
  checkoutHash: string | null;
  checkoutNeedsFull: boolean;
}
export const catalogConnection = (): CatalogConnection => ({
  acknowledged: null,
  pending: null,
  forceFull: true,
  blockedRevision: null,
  checkoutSeq: -1,
  checkoutHash: null,
  checkoutNeedsFull: true,
});
const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024;
const publicUrl = (value: string | null) => {
  if (value === null || value.startsWith("/") || value.startsWith("file://")) return null;
  return remoteUrl(value);
};
function diff<T extends { id: string }>(before: T[], after: T[]) {
  const old = new Map(before.map((row) => [row.id, canonical(row)])),
    ids = new Set(after.map((row) => row.id));
  return {
    upserts: after.filter((row) => old.get(row.id) !== canonical(row)),
    removed: before.filter((row) => !ids.has(row.id)).map((row) => row.id),
  };
}

// Owns the read-only projection and its ACK bases, separately from execution authority.
export class TowerCatalog {
  private cached: RepositoryCatalog | null = null;
  constructor(
    private w: Workspace,
    private send: (socket: Socket, message: unknown) => unknown,
  ) {}
  snapshot(): RepositoryCatalog {
    const revision = this.w.one<{ revision: number }>(
      "SELECT revision FROM repository_catalog_clock WHERE id=1",
    )!.revision;
    if (this.cached?.revision === revision) return this.cached;
    const projects = this.w.all<{ id: string; name: string }>(
      "SELECT id,name FROM projects ORDER BY id LIMIT 5001",
    );
    const rows = this.w.all<{
      id: string;
      name: string;
      upstream_url: string | null;
      url_aliases: string;
    }>("SELECT id,name,upstream_url,url_aliases FROM repositories ORDER BY id LIMIT 5001");
    if (projects.length > 5000 || rows.length > 5000)
      throw new AppError(
        "catalog_record_limit",
        "Catalog cannot exceed 5000 projects or repositories",
      );
    const repositories = rows.map((row) => ({
      ...row,
      upstream_url: publicUrl(row.upstream_url),
      url_aliases: (JSON.parse(row.url_aliases) as string[])
        .map(publicUrl)
        .filter((url): url is string => url !== null),
      project_ids: this.w.history.projects.list(row.id).map((link) => link.project_id),
    }));
    const catalog = catalogSchema.safeParse({ revision, projects, repositories });
    if (!catalog.success)
      throw new AppError(
        "catalog_invalid",
        "Catalog exceeds its entity bounds or has invalid references",
      );
    if (
      !fits({
        jsonrpc: "2.0",
        id: `catalog:${"x".repeat(100)}`,
        method: "catalog.push",
        params: catalog.data,
      })
    )
      throw new AppError("catalog_frame_too_large", "Catalog must fit within 1 MiB");
    this.cached = catalog.data;
    return catalog.data;
  }
  connected(socket: Socket) {
    this.w.run(
      "INSERT INTO machine_catalog_sync(machine_id) VALUES(?) ON CONFLICT(machine_id) DO UPDATE SET catalog_revision=0,catalog_error=NULL,checkout_error=NULL,checkouts_current=0",
      socket.data.machineId,
    );
  }
  private permitted(socket: Socket) {
    return (
      socket.data.scopes.includes("read") &&
      socket.data.capabilities.includes("repository-catalog.v1")
    );
  }
  wake(socket: Socket) {
    if (!this.permitted(socket)) return;
    const state = socket.data.catalog;
    if (!state.pending) {
      let catalog: RepositoryCatalog;
      try {
        catalog = this.snapshot();
      } catch (error) {
        this.w.run(
          "UPDATE machine_catalog_sync SET catalog_error=? WHERE machine_id=?",
          error instanceof AppError ? error.code : "catalog_invalid",
          socket.data.machineId,
        );
        socket.close(4009, error instanceof AppError ? error.code : "catalog_invalid");
        return;
      }
      if (
        state.blockedRevision === catalog.revision ||
        (!state.forceFull && state.acknowledged?.revision === catalog.revision)
      )
        return;
      const frame: Frame = {
        jsonrpc: "2.0",
        id: `catalog:${uid("attempt")}`,
        method: "catalog.push",
        params: catalog,
      };
      if (
        !state.forceFull &&
        state.acknowledged &&
        socket.data.capabilities.includes("repository-catalog-delta.v1")
      ) {
        const delta = {
          base_revision: state.acknowledged.revision,
          revision: catalog.revision,
          projects: diff(state.acknowledged.projects, catalog.projects),
          repositories: diff(state.acknowledged.repositories, catalog.repositories),
        };
        if (Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(catalog))) {
          frame.method = "catalog.delta";
          frame.params = delta;
        }
      }
      if (!fits(frame)) {
        this.w.run(
          "UPDATE machine_catalog_sync SET catalog_error='catalog_frame_too_large' WHERE machine_id=?",
          socket.data.machineId,
        );
        socket.close(4009, "catalog_frame_too_large");
        return;
      }
      state.pending = { frame, catalog, sentAt: 0 };
      state.forceFull = false;
    }
    const pending = state.pending;
    if (!pending.sentAt || Date.now() - pending.sentAt >= 30000) {
      pending.sentAt = Date.now();
      this.send(socket, pending.frame);
    }
  }
  handle(socket: Socket, message: Record<string, unknown>): boolean {
    const method = message.method;
    const state = socket.data.catalog;
    if (
      typeof message.id === "string" &&
      message.id.startsWith("catalog:") &&
      ("result" in message || "error" in message)
    ) {
      if (!this.permitted(socket))
        throw new AppError("catalog_scope_required", "Catalog needs machine read consent");
      if (message.id !== state.pending?.frame.id) return true;
      const pending = state.pending;
      if (message.error) {
        state.blockedRevision = pending.catalog.revision;
        state.pending = null;
        this.w.run(
          "UPDATE machine_catalog_sync SET catalog_error='catalog_rejected' WHERE machine_id=?",
          socket.data.machineId,
        );
        this.w.onChange();
        return true;
      }
      const ack = catalogAckSchema.parse(message.result);
      if (ack.revision !== pending.catalog.revision)
        throw new AppError("catalog_ack_conflict", "Catalog ACK does not match the sent revision");
      state.acknowledged = pending.catalog;
      state.pending = null;
      state.blockedRevision = null;
      this.w.run(
        "UPDATE machine_catalog_sync SET catalog_revision=?,catalog_error=NULL WHERE machine_id=?",
        ack.revision,
        socket.data.machineId,
      );
      if (state.checkoutNeedsFull && socket.data.capabilities.includes("checkout-sync.v1"))
        this.resync(socket);
      this.w.onChange();
      return true;
    }
    if (!["catalog.resync", "checkout.snapshot", "checkout.delta"].includes(String(method)))
      return false;
    if (!this.permitted(socket))
      throw new AppError(
        "catalog_scope_required",
        "Catalog needs negotiated support and machine read consent",
      );
    if (method === "catalog.resync") {
      resyncSchema.parse(message.params);
      state.pending = null;
      state.forceFull = true;
      state.blockedRevision = null;
      this.wake(socket);
      return true;
    }
    if (!socket.data.capabilities.includes("checkout-sync.v1"))
      throw new AppError("unsupported_capability", "Negotiate checkout-sync.v1");
    try {
      this.checkouts(socket, method === "checkout.snapshot", message.params);
    } catch (error) {
      this.w.run(
        "UPDATE machine_catalog_sync SET checkout_error=? WHERE machine_id=?",
        error instanceof AppError ? error.code : "checkout_invalid",
        socket.data.machineId,
      );
      throw error;
    }
    return true;
  }
  private resync(socket: Socket) {
    socket.data.catalog.checkoutNeedsFull = true;
    this.w.run(
      "UPDATE machine_catalog_sync SET checkouts_current=0 WHERE machine_id=?",
      socket.data.machineId,
    );
    this.send(socket, { jsonrpc: "2.0", method: "checkout.resync", params: {} });
  }
  private checkouts(socket: Socket, full: boolean, input: unknown) {
    const state = socket.data.catalog,
      machine = socket.data.machineId;
    const frame = full ? checkoutSnapshotSchema.parse(input) : checkoutDeltaSchema.parse(input);
    const fingerprint = digest(
      canonical({ method: full ? "checkout.snapshot" : "checkout.delta", params: frame }),
    );
    if (frame.seq === state.checkoutSeq) {
      if (fingerprint !== state.checkoutHash)
        throw new AppError(
          "checkout_sequence_conflict",
          "Checkout sequence was reused with different data",
        );
      this.send(socket, { jsonrpc: "2.0", method: "checkout.ack", params: { cursor: frame.seq } });
      return;
    }
    if (
      !state.acknowledged ||
      frame.seq < state.checkoutSeq ||
      (!full &&
        (state.checkoutNeedsFull || (frame as { base_seq: number }).base_seq !== state.checkoutSeq))
    ) {
      this.resync(socket);
      return;
    }
    const upserts = "records" in frame ? frame.records : frame.upserts;
    const removed = "removed" in frame ? frame.removed : [];
    const authorized = new Set(state.acknowledged.repositories.map((r) => r.id));
    this.w.db
      .transaction(() => {
        const retained = this.w.all<{ checkout_id: string; record: string; present: number }>(
          "SELECT checkout_id,record,present FROM tower_checkouts WHERE machine_id=?",
          machine,
        );
        const before = new Map(
          retained.map((r) => [r.checkout_id, JSON.parse(r.record) as TowerCheckout]),
        );
        const next = full
          ? new Map<string, TowerCheckout>()
          : new Map(
              retained
                .filter((r) => r.present)
                .map((r) => [r.checkout_id, before.get(r.checkout_id)!]),
            );
        for (const record of upserts) {
          if (
            record.repository_id &&
            (!authorized.has(record.repository_id) ||
              !this.w.one("SELECT id FROM repositories WHERE id=?", record.repository_id))
          )
            throw new AppError(
              "checkout_repository_denied",
              "Checkout repository is absent from the acknowledged catalog",
            );
          const old = before.get(record.id);
          if (
            old &&
            (record.revision < old.revision ||
              (record.revision === old.revision && canonical(record) !== canonical(old)))
          )
            throw new AppError(
              "checkout_revision_conflict",
              "Checkout revision is stale or identifies different data",
            );
          next.set(record.id, record);
        }
        for (const id of removed) next.delete(id);
        if (
          next.size > 5000 ||
          !fits({
            jsonrpc: "2.0",
            method: "checkout.snapshot",
            params: { seq: frame.seq, full: true, records: [...next.values()] },
          })
        )
          throw new AppError(
            "checkout_projection_too_large",
            "Full checkout recovery must fit 5000 records and 1 MiB",
          );
        if (full) this.w.run("UPDATE tower_checkouts SET present=0 WHERE machine_id=?", machine);
        for (const id of removed)
          this.w.run(
            "UPDATE tower_checkouts SET present=0 WHERE machine_id=? AND checkout_id=?",
            machine,
            id,
          );
        for (const record of upserts)
          this.w.run(
            "INSERT INTO tower_checkouts(machine_id,checkout_id,repository_id,record,received_at,present) VALUES(?,?,?,?,?,1) ON CONFLICT(machine_id,checkout_id) DO UPDATE SET repository_id=excluded.repository_id,record=excluded.record,received_at=excluded.received_at,present=1",
            machine,
            record.id,
            record.repository_id,
            canonical(record),
            this.w.now(),
          );
        this.w.run(
          "UPDATE machine_catalog_sync SET checkout_error=NULL,checkout_received_at=?,checkouts_current=1 WHERE machine_id=?",
          this.w.now(),
          machine,
        );
      })
      .immediate();
    state.checkoutSeq = frame.seq;
    state.checkoutHash = fingerprint;
    state.checkoutNeedsFull = false;
    this.send(socket, { jsonrpc: "2.0", method: "checkout.ack", params: { cursor: frame.seq } });
    this.w.onChange();
  }
}

export function checkoutObservations(
  w: Workspace,
  filter: {
    machine_id?: string;
    repository_id?: string;
    checkout_id?: string;
    include_removed?: boolean;
  },
): CheckoutObservation[] {
  const rows = w.all<{
    machine_id: string;
    checkout_id: string;
    record: string;
    received_at: string;
    present: number;
    connected: number;
    checkouts_current: number;
  }>(
    "SELECT c.*,m.connected,s.checkouts_current FROM tower_checkouts c JOIN machines m ON m.id=c.machine_id LEFT JOIN machine_catalog_sync s ON s.machine_id=m.id WHERE (? IS NULL OR c.machine_id=?) AND (? IS NULL OR c.repository_id=?) AND (? IS NULL OR c.checkout_id=?) AND (c.present=1 OR ?)",
    filter.machine_id ?? null,
    filter.machine_id ?? null,
    filter.repository_id ?? null,
    filter.repository_id ?? null,
    filter.checkout_id ?? null,
    filter.checkout_id ?? null,
    Number(filter.include_removed ?? false),
  );
  const observations: CheckoutObservation[] = rows.map((row) => {
    const { id, ...record } = JSON.parse(row.record) as TowerCheckout;
    return {
      ...record,
      identity: "tower",
      checkout_id: id,
      machine_id: row.machine_id,
      received_at: row.received_at,
      present: !!row.present,
      connected: !!row.connected && !!row.checkouts_current,
    };
  });
  if (filter.checkout_id !== undefined) return observations;
  // Legacy reports have no Tower-issued identity. Do not invent one from a path
  // or expose the old database surrogate; a stable full snapshot supersedes them.
  const legacy = w.all<{
    machine_id: string;
    repository_id: string | null;
    path: string;
    branch: string | null;
    head: string | null;
    tracking_ref: string | null;
    ahead: number | null;
    behind: number | null;
    observed_at: string | null;
    source_revision: number | null;
  }>(
    "SELECT c.machine_id,c.repository_id,c.path,o.branch,o.head,o.tracking_ref,o.ahead,o.behind,o.observed_at,o.source_revision FROM checkouts c LEFT JOIN checkout_observations o ON o.checkout_id=c.id WHERE NOT EXISTS(SELECT 1 FROM machine_catalog_sync s WHERE s.machine_id=c.machine_id AND s.checkout_received_at IS NOT NULL) AND (? IS NULL OR c.machine_id=?) AND (? IS NULL OR c.repository_id=?)",
    filter.machine_id ?? null,
    filter.machine_id ?? null,
    filter.repository_id ?? null,
    filter.repository_id ?? null,
  );
  for (const row of legacy) {
    const { source_revision, observed_at, ...record } = row;
    observations.push({
      ...record,
      identity: "legacy_path",
      checkout_id: null,
      system: "git",
      dirty: null,
      conflicts: null,
      locked: null,
      prunable: null,
      available: null,
      observed_at: observed_at ? Date.parse(observed_at) : null,
      revision: source_revision,
      received_at: null,
      present: true,
      connected: false,
    });
  }
  return observations.sort(
    (a, b) =>
      a.machine_id.localeCompare(b.machine_id) ||
      a.path.localeCompare(b.path) ||
      String(a.checkout_id).localeCompare(String(b.checkout_id)),
  );
}
