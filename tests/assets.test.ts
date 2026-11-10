import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HTMLBundle } from "bun";
import { loadAssets, watchAssets } from "../server/assets.ts";

async function script(handler: (request: Request) => Promise<Response>) {
  const html = await (await handler(new Request("http://localhost/"))).text();
  const source = html.match(/src="(\/[^"]+\.js)"/)?.[1];
  if (!source) throw new Error(`No script in ${html}`);
  return (await handler(new Request(`http://localhost${source}`))).text();
}

test("watched browser assets rebuild after a source edit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "allgather-assets-"));
  const entry = join(directory, "main.ts");
  writeFileSync(entry, 'document.title = "first-build";\n');
  writeFileSync(
    join(directory, "index.html"),
    '<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>\n',
  );
  const bundle = (await import(join(directory, "index.html"))).default as HTMLBundle;
  const unwatch = watchAssets(directory, [bundle]);
  try {
    const handler = await loadAssets(bundle);
    expect(await script(handler)).toContain("first-build");
    writeFileSync(entry, "document.title = (;\n");
    let failure: Response | undefined;
    for (let attempt = 0; attempt < 100 && failure?.status !== 500; attempt++) {
      await Bun.sleep(50);
      failure = await handler(new Request("http://localhost/"));
    }
    expect(failure?.status).toBe(500);
    writeFileSync(entry, 'document.title = "second-build";\n');
    let rebuilt = "";
    for (let attempt = 0; attempt < 100 && !rebuilt.includes("second-build"); attempt++) {
      await Bun.sleep(50);
      rebuilt = await script(handler).catch(() => "");
    }
    expect(rebuilt).toContain("second-build");
  } finally {
    unwatch();
    rmSync(directory, { recursive: true, force: true });
  }
});
