import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, secret } from "../server/auth.ts";
import { startServer } from "../server/index.ts";
import { browserPasskeyLogin, browserSession } from "./browser.ts";
import { fixtureLoginLink } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to Chromium");
const root = mkdtempSync(join(tmpdir(), "allgather-enrollment-ui-"));
const running = await startServer({
  dataDir: root,
  port: 0,
  ownerUrl: "http://localhost:0",
  gitSyncSeconds: 0,
});
let browser: Awaited<ReturnType<typeof browserSession>> | undefined;
try {
  const origin = running.settings.ownerUrl;
  const post = (path: string, body: unknown, token?: string) =>
    fetch(origin + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  browser = await browserSession(executable);
  const b = browser;
  await b.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await b.command("Page.navigate", { url: origin + "/?view=sessions" });
  await browserPasskeyLogin(b, await fixtureLoginLink(root));
  await b.until(`[...document.querySelectorAll('button')].some(b=>b.textContent==='Machines')`);
  await b.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent==='Machines').click()`,
  );
  await b.until(`document.body.textContent.includes('Create pairing code')`);
  if (
    await b.evaluate<boolean>(
      `[...document.querySelectorAll('.pairing input[type="checkbox"]')].slice(2).some(c=>c.checked)`,
    )
  )
    throw new Error("Execution must require explicit owner consent");
  await b.evaluate(`document.querySelector('.pairing input[maxlength="160"]').focus()`);
  await b.command("Input.insertText", { text: "Browser fixture node" });
  await b.evaluate(`document.querySelectorAll('.pairing input[type="checkbox"]')[3].click()`);
  await b.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent==='Create pairing code').click()`,
  );
  await b.until(`!!document.querySelector('textarea[aria-label="Pairing code"]')`);
  const code = await b.evaluate<string>(
    `document.querySelector('textarea[aria-label="Pairing code"]').value`,
  );
  if (await b.evaluate<boolean>(`document.documentElement.scrollWidth>innerWidth`))
    throw new Error("Pairing overflows mobile viewport");
  const response = await post("/api/tower/enrollments", {
    pairing_code: code,
    request_id: secret(),
    host_id: "browser-fixture-host",
    tower_version: "fixture",
    requested_scopes: ["read", "send", "acp:control", "terminal:control"],
  });
  if (!response.ok) throw new Error(`Pairing failed: ${response.status}`);
  const e = await response.json(),
    path = `/api/tower/enrollments/${e.enrollment_id}`;
  const approved = e;
  if (
    approved.node_label !== "Browser fixture node" ||
    approved.scopes.includes("acp:control") ||
    !approved.scopes.includes("terminal:control")
  )
    throw new Error("Owner consent was not enforced");
  if (
    !(
      await post(
        `${path}/confirm`,
        { credential_id: approved.credential_id, access_key_hash: hash(approved.access_key) },
        e.confirmation_token,
      )
    ).ok
  )
    throw new Error("Confirmation failed");
  await b.until(`document.body.textContent.includes('Pairing confirmed')`);
  if (await b.evaluate<boolean>(`!!document.querySelector('textarea[aria-label="Pairing code"]')`))
    throw new Error("Consumed code remains visible");
  await b.command("Page.navigate", { url: e.authorization_url });
  await b.until(`document.body.textContent.includes('completed pairing')`);
  if (
    await b.evaluate<boolean>(
      `[...document.querySelectorAll('button')].some(b=>b.textContent==='Authorize')`,
    )
  )
    throw new Error("Obsolete open enrollment approval remains");
  console.log(
    "Browser pairing passed: owner-created code, control opt-in, scope intersection, name, private status, consumed code, durable confirmation and mobile layout. Synthetic device HTTP only.",
  );
} finally {
  await browser?.close();
  await running.stop();
  rmSync(root, { recursive: true, force: true });
}
