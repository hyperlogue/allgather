import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../server/index.ts";
import { browserPasskeyLogin, browserSession } from "./browser.ts";
import { fixtureLoginLink } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to Chromium");
const root = mkdtempSync(join(tmpdir(), "allgather-cli-pairing-ui-"));
const running = await startServer({
  dataDir: join(root, "server"),
  port: 0,
  ownerUrl: "http://localhost:0",
  gitSyncSeconds: 0,
});
let browser: Awaited<ReturnType<typeof browserSession>> | undefined;
try {
  const origin = running.settings.ownerUrl;
  browser = await browserSession(executable);
  const b = browser;
  await b.command("Page.navigate", { url: origin + "/?view=connections" });
  await browserPasskeyLogin(b, await fixtureLoginLink(join(root, "server")));
  await b.until(`!!document.querySelector('.cli-pairing input[maxlength="160"]')`);
  await b.evaluate(`document.querySelector('.cli-pairing input[maxlength="160"]').focus()`);
  await b.command("Input.insertText", { text: "Remote browser fixture" });
  if (
    await b.evaluate(
      `document.querySelector('.cli-pairing [aria-label="Administration access"]').value!=='deny' || document.querySelector('.cli-pairing [aria-label="Launch a coding agent on a machine"]').value!=='approval'`,
    )
  )
    throw new Error("CLI pairing defaults permit unexpected access");
  await b.until(
    `[...document.querySelectorAll('.cli-pairing button')].some(b=>b.textContent==='Create CLI pairing code' && !b.disabled)`,
  );
  await b.evaluate(
    `[...document.querySelectorAll('.cli-pairing button')].find(b=>b.textContent==='Create CLI pairing code').click()`,
  );
  await b.until(`!!document.querySelector('textarea[aria-label="CLI pairing code"]')`);
  for (const width of [1440, 390]) {
    await b.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 760,
    });
    if (await b.evaluate(`document.documentElement.scrollWidth>innerWidth`))
      throw new Error(`CLI pairing overflows at ${width}`);
  }
  const code = await b.evaluate<string>(
    `document.querySelector('textarea[aria-label="CLI pairing code"]').value`,
  );
  const command = process.argv[2]
    ? [resolve(process.argv[2])]
    : [process.execPath, "--no-env-file", resolve("cli/index.ts")];
  const child = Bun.spawn([...command, "login", origin, "--pairing-code-stdin", "--json"], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      ALLGATHER_CONFIG_DIR: join(root, "cli"),
      ALLGATHER_TOKEN: undefined,
      ALLGATHER_URL: undefined,
    },
    stdin: new Blob([code + "\n"]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`CLI pairing failed: ${err}`);
  if (
    !JSON.parse(out).authenticated ||
    (out + err).includes(code) ||
    err.includes("/oauth/authorize")
  )
    throw new Error("CLI login leaked its pairing code or used a browser callback");
  await b.until(
    `document.querySelector('.cli-pairing').textContent.includes('The CLI saved its credentials.')`,
  );
  if (await b.evaluate(`!!document.querySelector('textarea[aria-label="CLI pairing code"]')`))
    throw new Error("Consumed CLI code remains visible");
  const tokens = JSON.parse(readFileSync(join(root, "cli", "credentials.json"), "utf8"))[origin];
  const grant = running.workspace.one<{ resources: string; permissions: string; scopes: string }>(
    "SELECT resources,permissions,scopes FROM oauth_grants WHERE client_id=?",
    tokens.client_id,
  )!;
  if (
    JSON.parse(grant.scopes).includes("admin") ||
    JSON.parse(grant.resources).project_ids.length ||
    JSON.parse(grant.permissions)["sessions:launch"] !== "approval"
  )
    throw new Error("CLI pairing did not preserve browser-selected access");
  await b.evaluate(
    `window.confirm=()=>true; [...[...document.querySelectorAll('.registered-clients li')].find(row=>row.textContent.includes('Remote browser fixture')).querySelectorAll('button')].find(button=>button.textContent==='Revoke').click()`,
  );
  await b.until(`document.querySelector('.connections').textContent.includes('Revoked')`);
  const denied = await fetch(origin + "/api/operations/projects_list", {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
    body: "{}",
  });
  if (denied.status !== 401) throw new Error("Browser revocation did not retire CLI access");
  console.log(
    "CLI pairing browser verification passed: owner permissions, hidden-code transport, remote CLI login, durable confirmation, mobile layout and revocation. Isolated synthetic server.",
  );
} finally {
  await browser?.close();
  await running.stop();
  rmSync(root, { recursive: true, force: true });
}
