import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import { browserSession } from "./browser.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to Chromium");
const root = mkdtempSync(join(tmpdir(), "allgather-passkeys-ui-"));
const running = await startServer({
  dataDir: root,
  port: 0,
  ownerUrl: "http://localhost:0",
  gitSyncSeconds: 0,
});
let browser: Awaited<ReturnType<typeof browserSession>> | undefined;
try {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "server/cli.ts", "login", "--data-dir", root, "--json"],
    {
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_STATE_HOME: root,
        ALLGATHER_CONFIG_DIR: join(root, "config"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status) throw new Error(`Login link command failed: ${err}`);
  const link = JSON.parse(out) as { id: string; url: string };
  const origin = running.settings.ownerUrl;
  browser = await browserSession(executable);
  const b = browser;
  await b.command("WebAuthn.enable");
  await b.command("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await b.command("Page.navigate", { url: link.url });
  await b.until(`document.querySelector('h1')?.textContent==='Welcome to AllGather'`);
  if (await b.evaluate(`location.hash!=='' || !!document.querySelector('.app-header')`))
    throw new Error("Welcome page leaked the link secret or exposed the workspace");
  const authenticated = await b.evaluate<boolean>(
    `fetch('/api/session').then(r=>r.json()).then(s=>s.authenticated)`,
  );
  if (authenticated) throw new Error("Opening the link created a session");
  if (
    running.workspace.one<{ consumed_at: string | null }>(
      "SELECT consumed_at FROM login_tokens WHERE id=?",
      link.id,
    )?.consumed_at
  )
    throw new Error("Opening the link consumed it");
  for (const width of [1440, 390]) {
    await b.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 760,
    });
    if (await b.evaluate("document.documentElement.scrollWidth>innerWidth"))
      throw new Error(`Welcome page overflow at ${width}`);
  }
  await b.evaluate(
    `Object.defineProperty(navigator.credentials,'create',{configurable:true,value:async()=>{throw new DOMException('Cancelled','NotAllowedError')}});document.querySelector('.login-enter').click()`,
  );
  await b.until(`!!document.querySelector('.login .error')`);
  if (
    running.workspace.one<{ consumed_at: string | null }>(
      "SELECT consumed_at FROM login_tokens WHERE id=?",
      link.id,
    )?.consumed_at
  )
    throw new Error("Cancelling passkey creation consumed the link");
  await b.evaluate(
    `delete navigator.credentials.create; document.querySelector('.login-enter').click()`,
  );
  await b.until(`!!document.querySelector('.app-header')`);
  const keys = running.workspace.all<{ id: string }>(
    "SELECT id FROM passkeys WHERE revoked_at IS NULL",
  );
  if (keys.length !== 1) throw new Error("Passkey was not durably registered");
  await b.command("Page.reload");
  await b.until(`!!document.querySelector('.app-header')`);
  await b.evaluate(
    `fetch('/api/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})`,
  );
  await b.command("Page.navigate", { url: origin });
  await b.until(`document.querySelector('.login-enter')?.textContent==='Sign in with passkey'`);
  await b.evaluate(`document.querySelector('.login-enter').click()`);
  await b.until(`!!document.querySelector('.app-header')`);
  await b.command("Page.navigate", { url: link.url });
  await b.until(`document.querySelector('.login-enter')?.textContent==='Create passkey and enter'`);
  await b.evaluate(`document.querySelector('.login-enter').click()`);
  await b.until(`document.querySelector('.login .error')?.textContent.includes('already used')`);
  await b.command("Page.navigate", { url: origin + "/?view=settings" });
  await b.until(
    `[...document.querySelectorAll('.settings button')].some(b=>b.textContent==='Revoke passkey' && !b.disabled)`,
  );
  await b.evaluate(
    `window.confirm=()=>true;[...document.querySelectorAll('.settings button')].find(b=>b.textContent==='Revoke passkey').click()`,
  );
  await b.until(`document.querySelector('.login-enter')?.textContent==='Sign in with passkey'`);
  if (running.workspace.one<{ n: number }>("SELECT COUNT(*) n FROM sessions")?.n !== 0)
    throw new Error("Revocation retained a browser session");
  console.log(
    "Passkey browser verification passed: CLI link, stripped fragment, mandatory enrollment, cancellation/retry, returning-user authentication, refresh persistence, replay rejection, mobile layout, and revocation. Chromium virtual authenticator; isolated server.",
  );
} finally {
  await browser?.close();
  await running.stop();
  rmSync(root, { recursive: true, force: true });
}
