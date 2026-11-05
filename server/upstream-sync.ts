import { lstat, readdir, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError } from "../shared/contracts.ts";
import type { NativeGit } from "./native-git.ts";
import type { Workspace } from "./workspace.ts";

async function diskBytes(path: string): Promise<number> {
  try {
    const s = await lstat(path);
    if (!s.isDirectory()) return s.blocks * 512;
    let sum = s.blocks * 512;
    for (const name of await readdir(path)) sum += await diskBytes(join(path, name));
    return sum;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
}
export class UpstreamSync {
  private timer?: ReturnType<typeof setInterval>;
  private scheduled?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private closed = false;
  private abort = new AbortController();
  private active?: { id: string; revision: number; controller: AbortController };
  private measuredAt?: number;
  constructor(
    private w: Workspace,
    readonly git: NativeGit,
    private intervalSeconds = 300,
  ) {}
  start() {
    this.w.run(
      "UPDATE repositories SET sync_status='queued',sync_requested=1 WHERE sync_status='running'",
    );
    this.timer = setInterval(
      () => this.wake(),
      Math.min(30000, (this.intervalSeconds || 30) * 1000),
    );
    this.wake();
  }
  wake() {
    if (this.active && this.w.history.repository(this.active.id).revision !== this.active.revision)
      this.active.controller.abort();
    if (this.closed || this.running || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      void this.runOnce().catch((e) =>
        console.error("Git scheduler:", e instanceof Error ? e.message : "failed"),
      );
    }, 0);
  }
  runOnce() {
    if (this.running) return this.running;
    if (this.closed) return Promise.resolve();
    this.running = this.refresh().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async refresh() {
    const candidates = this.w.all<{ id: string }>(
      "SELECT id FROM repositories WHERE upstream_url IS NOT NULL AND (cleanup_requested=1 OR sync_requested=1 OR (?=1 AND sync_enabled=1 AND (next_sync_at IS NULL OR next_sync_at<=?))) ORDER BY COALESCE(next_sync_at,''),id",
      Number(this.intervalSeconds > 0),
      this.w.now(),
    );
    for (const { id } of candidates) {
      if (this.closed) break;
      let repo = this.w.history.repository(id);
      const next = () =>
        new Date(
          this.w.clock().getTime() + Math.max(30, this.intervalSeconds) * 1000,
        ).toISOString();
      try {
        if (repo.cleanup_requested) {
          await this.git.clear(id);
          this.w.run(
            "UPDATE repositories SET cleanup_requested=0,cache_cleanup='idle',actual_cache_mode='none' WHERE id=?",
            id,
          );
          if (!repo.sync_requested) continue;
        }
        repo = this.w.history.beginSync(id);
        this.active = { id, revision: repo.revision, controller: new AbortController() };
        const signal = AbortSignal.any([
            this.abort.signal,
            this.active.controller.signal,
            AbortSignal.timeout(300000),
          ]),
          result = await this.git.collect(repo, this.w.history.checkpoint(id), signal);
        this.w.history.completeSync(repo, result, next());
        try {
          await this.git.prune(repo, signal);
          this.w.run("UPDATE repositories SET cache_cleanup='idle' WHERE id=?", id);
        } catch {
          this.w.run("UPDATE repositories SET cache_cleanup='error' WHERE id=?", id);
        }
      } catch (e) {
        if (this.w.history.repository(id).revision !== repo.revision) continue;
        if (e instanceof AppError && e.code === "filter_unsupported")
          this.w.run("UPDATE repositories SET actual_cache_mode='none' WHERE id=?", id);
        this.w.history.failSync(
          id,
          repo.revision,
          e instanceof AppError ? e.message : "Git collection failed",
          next(),
        );
      } finally {
        this.active = undefined;
      }
    }
    const now = this.w.clock().getTime();
    // Task/session notifications wake the collector too. A dated storage sample
    // does not need a fresh recursive filesystem walk on every such notification.
    if (
      candidates.length ||
      this.measuredAt === undefined ||
      now < this.measuredAt ||
      now - this.measuredAt >= 30000
    ) {
      await this.measure();
      this.w.onChange();
    }
  }
  async measure() {
    const data = this.w.options.dataDir ?? dirname(this.git.root),
      repositories = this.w.history.repositories(),
      cache_bytes_by_repo: Record<string, number> = {};
    for (const r of repositories) cache_bytes_by_repo[r.id] = await diskBytes(this.git.path(r.id));
    let free: number | null = null;
    try {
      const fs = await statfs(data);
      free = fs.bavail * fs.bsize;
    } catch {
      /* A transient missing data directory is shown as unknown. */
    }
    const at = this.w.now(),
      measurement = {
        database_bytes: await diskBytes(join(data, "allgather.sqlite")),
        wal_bytes: await diskBytes(join(data, "allgather.sqlite-wal")),
        blob_store_bytes: await diskBytes(join(data, "blobs")),
        cache_bytes_by_repo,
        cache_mode_by_repo: Object.fromEntries(
          repositories.map((r) => [r.id, r.actual_cache_mode]),
        ),
        indexed_count_by_repo: Object.fromEntries(repositories.map((r) => [r.id, r.indexed_count])),
        free_bytes: free,
      };
    type Sample = {
      at: string;
      total_bytes: number;
      blob_store_bytes: number;
      cache_bytes: number;
      database_bytes: number;
    };
    const cacheBytes = Object.values(cache_bytes_by_repo).reduce((sum, bytes) => sum + bytes, 0),
      dbBytes = measurement.database_bytes + measurement.wal_bytes;
    const sample: Sample = {
      at,
      total_bytes: cacheBytes + dbBytes + measurement.blob_store_bytes,
      blob_store_bytes: measurement.blob_store_bytes,
      cache_bytes: cacheBytes,
      database_bytes: dbBytes,
    };
    const prior = this.w.one<{ value: string }>(
      "SELECT value FROM storage_observations WHERE id=1",
    );
    const history = ((prior ? JSON.parse(prior.value).history : []) ?? ([] as Sample[])).filter(
      (s: Sample) => Date.parse(s.at) >= Date.parse(at) - 86400000 && s.at < at,
    ) as Sample[];
    const baseline = history[0];
    const growth = baseline
      ? {
          since: baseline.at,
          total_bytes: sample.total_bytes - baseline.total_bytes,
          database_bytes: sample.database_bytes - baseline.database_bytes,
          blob_store_bytes: sample.blob_store_bytes - baseline.blob_store_bytes,
          cache_bytes: sample.cache_bytes - baseline.cache_bytes,
        }
      : null;
    if (!history.length || Date.parse(at) - Date.parse(history.at(-1)!.at) >= 300000)
      history.push(sample);
    this.w.run(
      "INSERT INTO storage_observations VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,value=excluded.value",
      at,
      JSON.stringify({ ...measurement, growth, history: history.slice(-288) }),
    );
    this.measuredAt = Date.parse(at);
  }

  async stop() {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.scheduled);
    this.abort.abort();
    await this.running;
  }
}
