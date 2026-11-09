import { AppError, type Principal } from "../shared/contracts.ts";
import { isBrowserOwner } from "./auth.ts";
import { setSetting, setting } from "./storage.ts";
import type { Workspace } from "./workspace.ts";

const assetSafe = `NOT EXISTS(SELECT 1 FROM session_runtimes r WHERE r.session_id IN (SELECT member_id FROM session_members WHERE session_id=(SELECT session_id FROM session_members WHERE member_id=a.session_id)) AND r.termination!='confirmed') AND NOT EXISTS(SELECT 1 FROM session_commands c WHERE c.session_id IN (SELECT member_id FROM session_members WHERE session_id=(SELECT session_id FROM session_members WHERE member_id=a.session_id)) AND c.state IN ('queued','sent'))`;
export class Transcripts {
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping: Promise<void> | null = null;
  constructor(private w: Workspace) {}
  authorize(p: Principal) {
    if (!isBrowserOwner(this.w.db, p, this.w.now()))
      throw new AppError("forbidden", "Manage transcript storage from the owner browser", 403);
  }
  settings(): { days: number | null; revision: number } {
    return JSON.parse(setting(this.w.db, "transcript_retention") ?? '{"days":null,"revision":1}');
  }
  preview(session: string) {
    session = this.w.sessions.get(session).id;
    return {
      target_session_id: session,
      through_sequence: this.w.one<{ n: number }>(
        "SELECT COALESCE(MAX(sequence),0) n FROM session_timeline WHERE session_id=?",
        session,
      )!.n,
      through_asset_sequence: this.w.one<{ n: number }>(
        "SELECT COALESCE(MAX(i.sequence),0) n FROM session_asset_identity i JOIN session_assets a ON a.id=i.id WHERE a.session_id IN (SELECT member_id FROM session_members WHERE session_id=?)",
        session,
      )!.n,
      events: this.w.one<{ n: number }>(
        "SELECT COUNT(*) n FROM session_timeline e JOIN session_event_content c ON c.id=e.event_id WHERE e.session_id=? AND c.payload IS NOT NULL",
        session,
      )!.n,
      assets: this.w.one<{ n: number }>(
        `SELECT COUNT(*) n FROM session_assets a WHERE a.session_id IN (SELECT member_id FROM session_members WHERE session_id=?) AND ${assetSafe}`,
        session,
      )!.n,
      retained_active_assets: this.w.one<{ n: number }>(
        `SELECT COUNT(*) n FROM session_assets a WHERE a.session_id IN (SELECT member_id FROM session_members WHERE session_id=?) AND NOT (${assetSafe})`,
        session,
      )!.n,
    };
  }
  read(name: string, a: Record<string, unknown>) {
    return name === "transcript_retention_get"
      ? this.settings()
      : this.preview(String(a.target_session_id));
  }
  write(name: string, a: Record<string, unknown>) {
    if (name === "transcript_retention_update") {
      const old = this.settings();
      if (old.revision !== a.expected_revision)
        throw new AppError("revision_conflict", "Read the current retention setting", 409);
      const value = { days: a.days as number | null, revision: old.revision + 1 };
      setSetting(this.w.db, "transcript_retention", JSON.stringify(value));
      return value;
    }
    const session = this.w.sessions.get(String(a.target_session_id));
    return this.erase(
      session.id,
      Number(a.through_sequence),
      Number(a.through_asset_sequence),
      "owner",
    );
  }
  private erase(
    session: string,
    events: number,
    assets: number,
    reason: string,
    cutoff: string | null = null,
  ) {
    return this.w.db
      .transaction(() => {
        const now = this.w.now();
        const changed = this.w.run(
          "UPDATE session_event_content SET payload=NULL,deleted_at=? WHERE payload IS NOT NULL AND id IN (SELECT e.id FROM session_timeline t JOIN session_events e ON e.id=t.event_id WHERE t.session_id=? AND t.sequence<=? AND (? IS NULL OR e.received_at<?))",
          now,
          session,
          events,
          cutoff,
          cutoff,
        ).changes;
        const removed = this.w.run(
          `DELETE FROM session_assets WHERE id IN (SELECT a.id FROM session_assets a JOIN session_asset_identity i ON i.id=a.id WHERE a.session_id IN (SELECT member_id FROM session_members WHERE session_id=?) AND i.sequence<=? AND (? IS NULL OR a.created_at<?) AND ${assetSafe})`,
          session,
          assets,
          cutoff,
          cutoff,
        ).changes;
        this.w.run(
          "UPDATE transcript_sources SET coverage='partial' WHERE id IN (SELECT e.source_id FROM session_events e JOIN session_event_content c ON c.id=e.id WHERE e.session_id IN (SELECT member_id FROM session_members WHERE session_id=?) AND c.deleted_at IS NOT NULL)",
          session,
        );
        if (changed || removed)
          this.w.run(
            "INSERT INTO transcript_deletions(session_id,through_sequence,through_asset_sequence,event_count,asset_count,reason,created_at) VALUES(?,?,?,?,?,?,?)",
            session,
            events,
            assets,
            changed,
            removed,
            reason,
            now,
          );
        return {
          target_session_id: session,
          deleted_events: changed,
          deleted_assets: removed,
          through_sequence: events,
          through_asset_sequence: assets,
        };
      })
      .immediate();
  }
  sweep() {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      const days = this.settings().days;
      if (days === null) return;
      const cutoff = new Date(Date.parse(this.w.now()) - days * 86400000).toISOString();
      const sessions = this.w.all<{ session_id: string }>(
        `SELECT t.session_id FROM session_events e JOIN session_timeline t ON t.event_id=e.id JOIN session_event_content c ON c.id=e.id WHERE c.payload IS NOT NULL AND e.received_at<? UNION SELECT m.session_id FROM session_assets a JOIN session_members m ON m.member_id=a.session_id WHERE a.created_at<? AND ${assetSafe} LIMIT 100`,
        cutoff,
        cutoff,
      );
      for (const row of sessions) {
        const events = this.w.one<{ n: number }>(
          "SELECT COALESCE(MAX(sequence),0) n FROM (SELECT t.sequence FROM session_timeline t JOIN session_events e ON e.id=t.event_id JOIN session_event_content c ON c.id=e.id WHERE t.session_id=? AND e.received_at<? AND c.payload IS NOT NULL ORDER BY t.sequence LIMIT 1000)",
          row.session_id,
          cutoff,
        )!.n;
        const assets = this.w.one<{ n: number }>(
          "SELECT COALESCE(MAX(sequence),0) n FROM (SELECT i.sequence FROM session_asset_identity i JOIN session_assets a ON a.id=i.id WHERE a.session_id IN (SELECT member_id FROM session_members WHERE session_id=?) AND a.created_at<? ORDER BY i.sequence LIMIT 1000)",
          row.session_id,
          cutoff,
        )!.n;
        this.erase(row.session_id, events, assets, `retention:${this.settings().revision}`, cutoff);
      }
      if (sessions.length) this.w.onChange();
      await this.w.artifacts?.collectBlobs();
    })().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }
  start() {
    this.timer = setInterval(
      () => void this.sweep().catch(() => console.error("Transcript retention sweep failed")),
      60000,
    );
    this.timer.unref();
    void this.sweep().catch(() => console.error("Transcript retention sweep failed"));
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.sweeping?.catch(() => {});
  }
}
