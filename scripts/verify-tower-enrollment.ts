import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../server/auth.ts";
import { startServer } from "../server/index.ts";
import { browserSession } from "./browser.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to Chromium");
const root = mkdtempSync(join(tmpdir(), "allgather-enrollment-ui-"));
const running = await startServer({
  dataDir: root,
  port: 0,
  publicUrl: "http://127.0.0.1:0",
  gitSyncSeconds: 0,
});
let browser: Awaited<ReturnType<typeof browserSession>> | undefined;
try {
  const origin = running.settings.publicUrl;
  const post = (path: string, body: unknown, token?: string) =>
    fetch(origin + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const enrollment = await (
    await post("/api/tower/enrollments", {
      host_id: "browser-fixture-host",
      tower_version: "fixture",
      requested_scopes: ["read", "send", "acp:control", "terminal:control"],
    })
  ).json();
  browser = await browserSession(executable);
  const b = browser;
  await b.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await b.command("Page.navigate", { url: enrollment.authorization_url });
  await b.until(`!!document.querySelector('input[type="password"]')`);
  await b.evaluate(`document.querySelector('input[type="password"]').focus()`);
  await b.command("Input.insertText", { text: readFileSync(join(root, "login-token"), "utf8") });
  await b.evaluate(`document.querySelector('button[type="submit"]').click()`);
  await b.until(`document.body.textContent.includes('browser-fixture-host')`);
  if (
    !(await b.evaluate<boolean>(
      `document.body.textContent.includes('Start and control managed agent sessions') && document.body.textContent.includes('Launch named coding agents in terminals')`,
    ))
  )
    throw new Error("Consent does not explain managed control");
  await b.evaluate(`document.querySelector('input[maxlength="160"]').focus()`);
  await b.evaluate(`document.querySelector('input[maxlength="160"]').select()`);
  await b.command("Input.insertText", { text: "Browser fixture node" });
  await b.evaluate(`document.querySelectorAll('input[type="checkbox"]')[2].click()`);
  await b.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent==='Authorize').click()`,
  );
  await b.until(`document.body.textContent.includes('Return to your terminal')`);
  if (await b.evaluate<boolean>(`document.documentElement.scrollWidth>innerWidth`))
    throw new Error("Enrollment overflows the mobile viewport");
  const path = `/api/tower/enrollments/${enrollment.enrollment_id}`;
  const approved = await (await post(`${path}/poll`, {}, enrollment.polling_token)).json();
  if (
    approved.node_label !== "Browser fixture node" ||
    approved.scopes.includes("acp:control") ||
    !approved.scopes.includes("terminal:control")
  )
    throw new Error("Browser consent did not preserve the name/scope choice");
  if (
    !(
      await post(
        `${path}/confirm`,
        { credential_id: approved.credential_id, access_key_hash: hash(approved.access_key) },
        enrollment.polling_token,
      )
    ).ok
  )
    throw new Error("Enrollment confirmation failed");
  console.log(
    "Browser enrollment passed: nested login, owner consent, name, separate terminal consent, scope reduction, polling, confirmation, and mobile layout.",
  );
} finally {
  await browser?.close();
  await running.stop();
  rmSync(root, { recursive: true, force: true });
}
