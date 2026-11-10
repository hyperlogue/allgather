import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../cli/args.ts";
import { readAttachmentFiles, saveAttachment } from "../cli/artifact-images.ts";
import {
  type ArtifactFlags,
  artifactTarget,
  metadata,
  validateArtifactOptions,
} from "../cli/artifact-options.ts";
import { redIcon } from "./fixtures/project-icons.ts";

test("artifact flags retain repeated images and metadata and reject incompatible targets", () => {
  const { flags } = parse([
    "artifact",
    "thread-add",
    "id",
    "--attach",
    "a.png",
    "--attach",
    "b.jpg",
  ]);
  expect(flags.attach).toEqual(["a.png", "b.jpg"]);
  expect(metadata(parse(["artifact", "list", "--meta", "a=b=c", "--meta", "x=y"]).flags)).toEqual({
    a: "b=c",
    x: "y",
  });
  expect(parse(["artifact", "search", "text", "--attention"]).flags.attention).toBe(true);
  const invalid: ArtifactFlags[] = [
    { file: "a", version: "1", view: "source", line: "0", quote: "a" },
    { file: "a", version: "1", view: "source", line: "2-1", quote: "a" },
    { file: "a", version: "1", view: "source", side: "old" },
    { file: "a", version: "1", view: "rendered", route: "#a" },
    { target: "{}", file: "a" },
  ];
  for (const f of invalid) expect(() => artifactTarget(f)).toThrow();
  expect(
    artifactTarget({ file: "a", version: "2", view: "diff", line: "1-3", side: "old" }, true),
  ).toEqual({ kind: "diff", versionSeq: 2, path: "a", locator: { start: 1, end: 3, side: "old" } });
  expect(() =>
    artifactTarget({ file: "a", version: "2", view: "source", quote: "changed" }, true),
  ).toThrow();
  expect(() => validateArtifactOptions("list", ["artifact", "list"], { attention: true })).toThrow(
    "Unsupported",
  );
  expect(() =>
    validateArtifactOptions("comment-edit", ["artifact", "comment-edit", "c"], {
      attach: ["a"],
      "clear-attachments": true,
    }),
  ).toThrow();
});

test("image preparation rejects symlinks and excessive attachments and saving cannot clobber", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-cli-images-"));
  try {
    const bytes = Buffer.from(redIcon, "base64");
    writeFileSync(join(root, "image.png"), bytes);
    symlinkSync(join(root, "image.png"), join(root, "link.png"));
    expect(await readAttachmentFiles(["image.png"], root)).toEqual([
      { mediaType: "image/png", base64: redIcon },
    ]);
    await expect(readAttachmentFiles(["link.png"], root)).rejects.toThrow("regular PNG/JPEG");
    await expect(readAttachmentFiles(Array(5).fill("image.png"), root)).rejects.toThrow(
      "four images",
    );
    await expect(saveAttachment(join(root, "image.png"), new Uint8Array([1]))).rejects.toThrow(
      "already exists",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
