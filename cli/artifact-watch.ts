import type { ArtifactWatchResult } from "../shared/artifacts.ts";
import type { Client } from "./client.ts";

export async function watchArtifact(
  client: Client,
  id: string,
  seconds: number,
): Promise<ArtifactWatchResult> {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds * 1000 > 2147483647)
    throw new Error("--timeout must be nonnegative seconds within 24 days");
  const timeout = seconds ? Math.max(1, Math.ceil(seconds * 1000)) : 0;
  const response = await client.request(
    `/api/artifacts/${encodeURIComponent(id)}/watch`,
    { ...client.operator, timeout_ms: timeout },
    {
      stream: true,
      ...(timeout ? { signal: AbortSignal.timeout(timeout + 5000) } : {}),
    },
  );
  if (!response.headers.get("content-type")?.startsWith("text/event-stream"))
    throw new Error("Backend did not return an SSE watch stream");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing watch stream");
  const decoder = new TextDecoder();
  let pending = "",
    event = "",
    eventBytes = 0,
    data: string[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Watch disconnected before a result; retry watch");
      pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length > 1024 * 1024) throw new Error("Watch event exceeds size limit");
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline === -1) break;
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        eventBytes += line.length;
        if (eventBytes > 1024 * 1024) throw new Error("Watch event exceeds size limit");
        if (line === "") {
          if (event === "error")
            throw new Error(JSON.parse(data.join("\n")).message ?? "Watch failed");
          if (event === "result") {
            const value = JSON.parse(data.join("\n"));
            if (
              !value ||
              !["comments", "archived", "timeout", "superseded", "cancelled", "deleted"].includes(
                value.result,
              )
            )
              throw new Error("Invalid watch result");
            return value as ArtifactWatchResult;
          }
          event = "";
          eventBytes = 0;
          data = [];
        } else if (line.startsWith("event:")) event = line.slice(6).trimStart();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
