import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";

export async function downloadArtifact(response: Response, output?: string) {
  const temporary = output ? `${output}.${randomUUID()}.tmp` : undefined;
  const file = temporary ? await open(temporary, "wx", 0o600) : undefined;
  const reader = response.body?.getReader();
  let bytes = 0;
  try {
    if (!reader) throw new Error("Missing download body");
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (file) await file.writeFile(chunk.value);
      else
        await new Promise<void>((resolve, reject) =>
          process.stdout.write(chunk.value, (error) => (error ? reject(error) : resolve())),
        );
      bytes += chunk.value.byteLength;
    }
    if (file && temporary && output) {
      await file.sync();
      await file.close();
      await link(temporary, output);
    }
    return bytes;
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await file?.close();
    if (temporary) await unlink(temporary);
  }
}
