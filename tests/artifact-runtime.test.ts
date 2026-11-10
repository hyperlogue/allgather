import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureFiles } from "../cli/capture.ts";
import { renderArtifactDocument } from "../server/artifact-document.ts";

test("runtime modules belong to Allgather rather than an upstream subtree", async () => {
  const root = resolve(import.meta.dir, "..");
  const script = new Bun.Transpiler({ loader: "ts" });
  const component = new Bun.Transpiler({ loader: "tsx" });
  for (const layer of ["server", "shared", "cli", "web"]) {
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(join(root, layer))) {
      expect(file.split("/")).not.toContain("r3");
      const path = join(root, layer, file);
      const source = (await Bun.file(path).text()).replace(/^#![^\n]*\n/, "");
      const transpiler = file.endsWith(".tsx") ? component : script;
      for (const dependency of transpiler.scanImports(source)) {
        if (!dependency.path.startsWith(".")) continue;
        const target = resolve(path, "..", dependency.path);
        expect(target.split("/")).not.toContain("r3");
        expect(target.startsWith(`${root}/workspace/`)).toBe(false);
        expect(target.startsWith(`${root}/third-party/`)).toBe(false);
      }
    }
  }
});

test("native capture retains bytes and rejects traversal and symlink inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-capture-"));
  try {
    writeFileSync(join(root, "notes.md"), "# Notes\n");
    expect(await captureFiles(root, ["notes.md"])).toEqual([
      {
        path: "notes.md",
        mediaType: "text/markdown; charset=utf-8",
        base64: Buffer.from("# Notes\n").toString("base64"),
      },
    ]);
    await expect(captureFiles(root, ["../notes.md"])).rejects.toThrow();
    symlinkSync(join(root, "notes.md"), join(root, "link.md"));
    await expect(captureFiles(root, ["link.md"])).rejects.toThrow("symbolic link");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native document rendering preserves stored revision and escapes executable markup", async () => {
  const rendered = await renderArtifactDocument(
    "# Notes\n\n<script>alert(1)</script>\n\n```ts\nconst value = 1;\n```",
    "notes.md",
  );
  expect(rendered.revision).toBe("r3-markdown-3");
  expect(rendered.html).toContain("Notes</h1>");
  expect(rendered.html).not.toContain("<script>alert(1)</script>");
  expect(rendered.html).toContain("&lt;script&gt;");
  expect(rendered.html).toContain("value");
});
