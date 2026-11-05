import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import { verifyArtifactBrowser } from "./artifact-browser.ts";
import { fixtureLoginToken } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to a Chromium executable");
const dir = mkdtempSync(join(tmpdir(), "allgather-artifact-ui-")),
  server = await startServer({
    dataDir: dir,
    port: 0,
    publicUrl: "http://127.0.0.1:0",
    gitSyncSeconds: 0,
  }),
  p = { id: "owner", kind: "owner", inlet: "browser", scopes: ["admin"] } as const;
try {
  const artifact = (await server.workspace.dispatch(
    "artifacts_create",
    { kind: "html", title: "Captured plan", operation_key: "create" },
    p,
  )) as { id: string };
  await server.workspace.dispatch(
    "artifacts_publish",
    {
      artifact_id: artifact.id,
      expected_seq: 0,
      content: {
        kind: "html",
        files: [
          {
            path: "index.html",
            mediaType: "text/html",
            base64: Buffer.from(
              "<h1>A captured plan</h1><p>Keep work and evidence together.</p>",
            ).toString("base64"),
          },
        ],
      },
      operation_key: "publish",
    },
    p,
  );
  await verifyArtifactBrowser(
    executable,
    server.settings.publicUrl,
    await fixtureLoginToken(dir),
    artifact.id,
  );
  console.log(
    "Artifact browser passed: opaque preview, runtime handshake, review comment, desktop and mobile.",
  );
} finally {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}
