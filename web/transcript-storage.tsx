import { useState } from "react";
import { call, mutation } from "./api.ts";
import { Button, Dialog, ErrorText, useAction } from "./ui.tsx";

type Settings = { days: number | null; revision: number };
type Preview = {
  target_session_id: string;
  through_sequence: number;
  through_asset_sequence: number;
  events: number;
  assets: number;
  retained_active_assets: number;
};
export function TranscriptStorage({
  sessionId,
  changed,
}: {
  sessionId?: string;
  changed: () => void;
}) {
  const [open, setOpen] = useState(false),
    [settings, setSettings] = useState<Settings | null>(null),
    [days, setDays] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [apply, setApply] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <>
      <Button
        variant="quiet"
        onClick={() => {
          setOpen(true);
          setConfirmed(false);
          setApply(false);
          void run(async () => {
            const s = await call<Settings>("transcript_retention_get", {});
            setSettings(s);
            setDays(s.days === null ? "" : String(s.days));
            if (sessionId)
              setPreview(
                await call<Preview>("transcript_delete_preview", { target_session_id: sessionId }),
              );
          });
        }}
      >
        Transcript storage
      </Button>
      {open && (
        <Dialog title="Transcript storage" close={() => setOpen(false)}>
          <ErrorText>{error}</ErrorText>
          <p>
            Delete captured event bodies and unused uploaded assets. Stable event identities and
            replay fingerprints remain. Task comments, command inputs, execution receipts, audit
            records, and existing backups are separate and remain.
          </p>
          {settings && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const s = await call<Settings>("transcript_retention_update", {
                    days: days === "" ? null : Number(days),
                    expected_revision: settings.revision,
                    ...mutation(),
                  });
                  setSettings(s);
                  setApply(false);
                  changed();
                  if (sessionId)
                    setPreview(
                      await call<Preview>("transcript_delete_preview", {
                        target_session_id: sessionId,
                      }),
                    );
                });
              }}
            >
              <label>
                Keep captured history for (days)
                <input
                  aria-label="Retention days"
                  type="number"
                  min={1}
                  max={3650}
                  value={days}
                  placeholder="Forever"
                  onChange={(event) => {
                    setDays(event.target.value);
                    setApply(false);
                  }}
                />
              </label>
              <p className="muted small">
                Blank keeps history forever. Saving a number applies now and then checks every
                minute. Assets used by active executions stay until safe to delete. Shared artifact
                files remain.
              </p>
              {days !== "" && (
                <label className="permission-choice">
                  <input
                    type="checkbox"
                    checked={apply}
                    onChange={(event) => setApply(event.target.checked)}
                  />
                  <span>Apply deletion to existing and future captured history.</span>
                </label>
              )}
              <button type="submit" disabled={busy || (days !== "" && !apply)}>
                Save retention
              </button>
            </form>
          )}
          {preview && (
            <section>
              <h3>Delete this session's captured history</h3>
              <p>
                {preview.events} event bodies and up to {preview.assets} assets from this preview.{" "}
                {preview.retained_active_assets} assets are protected by execution state. Newer
                captures are outside this request.
              </p>
              <label className="permission-choice">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>Delete the captured history shown above.</span>
              </label>
              <button
                type="button"
                disabled={busy || !confirmed}
                onClick={() =>
                  void run(async () => {
                    await call("transcript_delete", {
                      target_session_id: preview.target_session_id,
                      through_sequence: preview.through_sequence,
                      through_asset_sequence: preview.through_asset_sequence,
                      ...mutation(),
                    });
                    setOpen(false);
                    changed();
                  })
                }
              >
                Delete captured history
              </button>
            </section>
          )}
        </Dialog>
      )}
    </>
  );
}
