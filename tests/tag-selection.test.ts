import { expect, test } from "bun:test";
import { selectTags } from "../server/tag-selection.ts";

test("tag selection preserves regex matches and interrupts pathological matching without blocking the server", async () => {
  const signal = new AbortController().signal;
  expect(
    await selectTags("^v[0-9]+\\.[0-9]+$", ["v1.2", "draft", "v22.3", "v1.2.3"], signal),
  ).toEqual(["v1.2", "v22.3"]);
  let responsive = false;
  const tick = setTimeout(() => {
    responsive = true;
  }, 10);
  try {
    await expect(
      selectTags("^" + "a*".repeat(24) + "b$", ["a".repeat(900)], signal),
    ).rejects.toThrow("one second");
    expect(responsive).toBe(true);
  } finally {
    clearTimeout(tick);
  }
  const stopped = new AbortController();
  stopped.abort();
  await expect(selectTags(".*", ["v1"], stopped.signal)).rejects.toThrow("cancelled");
}, 5000);
