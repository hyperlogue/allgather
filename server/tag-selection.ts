import { Worker } from "node:worker_threads";
import { AppError } from "../shared/contracts.ts";
// A syntactically valid expression can still backtrack for an unbounded time.
// Run the complete advertised tag set off the server thread and terminate it at the deadline.
export function selectTags(
  pattern: string,
  tags: string[],
  signal: AbortSignal,
): Promise<string[]> {
  if (signal.aborted) return Promise.reject(new AppError("cancelled", "Git collection cancelled"));
  if (!tags.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads');const regex=new RegExp(workerData.pattern);parentPort.postMessage(workerData.tags.filter(tag=>regex.test(tag)));`,
      { eval: true, workerData: { pattern, tags } },
    );
    let settled = false;
    const finish = (error: Error | null, value?: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value ?? []);
    };
    const abort = () => finish(new AppError("cancelled", "Git collection cancelled"));
    const timer = setTimeout(
      () =>
        finish(
          new AppError(
            "tag_regex_timeout",
            "Tag selection exceeded one second. Use a simpler tag expression.",
            409,
          ),
        ),
      1000,
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (value: string[]) => finish(null, value));
    worker.once("error", () => finish(new AppError("invalid_tag_regex", "Tag selection failed")));
    worker.once("exit", () => {
      if (!settled) finish(new AppError("tag_selection_failed", "Tag selection worker stopped"));
    });
    if (signal.aborted) abort();
  });
}
