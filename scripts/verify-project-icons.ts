import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import { browserSession } from "./browser.ts";
import { fixtureLogin } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to Chromium");
const root = mkdtempSync(join(tmpdir(), "allgather-project-icons-"));
const running = await startServer({
  dataDir: join(root, "state"),
  port: 0,
  ownerUrl: "http://localhost:0",
  gitSyncSeconds: 0,
});
const browser = await browserSession(executable);
try {
  await browser.command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const cookie = await fixtureLogin(join(root, "state"), running.settings.ownerUrl);
  const separator = cookie.indexOf("=");
  await browser.command("Network.setCookie", {
    name: cookie.slice(0, separator),
    value: cookie.slice(separator + 1),
    url: running.settings.ownerUrl,
  });
  await browser.command("Page.navigate", { url: running.settings.ownerUrl });
  await browser.until("!!document.querySelector('.app-header')");
  const click = async (text: string) =>
    browser.evaluate(
      `(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!el)throw new Error('Missing button '+${JSON.stringify(text)});el.click()})()`,
    );
  const field = async (name: string, value: string) =>
    browser.evaluate(
      `(()=>{const label=[...document.querySelectorAll('dialog label')].find(l=>l.childNodes[0]?.textContent.trim()===${JSON.stringify(name)});const el=label.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  const upload = async (file: string) => {
    const doc = await browser.command("DOM.getDocument");
    const node = await browser.command("DOM.querySelector", {
      nodeId: (doc.root as { nodeId: number }).nodeId,
      selector: 'dialog input[type="file"]',
    });
    await browser.command("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [file] });
  };
  const picture = async (color: string, file: string, format: string) => {
    const data = await browser.evaluate<string>(
      `(()=>{const c=document.createElement('canvas');c.width=320;c.height=160;const x=c.getContext('2d');x.fillStyle=${JSON.stringify(color)};x.fillRect(0,0,320,160);x.fillStyle='white';x.font='bold 90px sans-serif';x.fillText('PX',95,112);return c.toDataURL(${JSON.stringify(format)}).split(',')[1]})()`,
    );
    writeFileSync(file, Buffer.from(data, "base64"));
  };
  const red = join(root, "red.jpg"),
    blue = join(root, "blue.webp"),
    invalid = join(root, "broken.png");
  await picture("#e55745", red, "image/jpeg");
  await picture("#397add", blue, "image/webp");
  writeFileSync(invalid, "not an image");
  await browser.evaluate("document.querySelector('.scope-switch').click()");
  await browser.until("!!document.querySelector('button[aria-label=\"New project\"]')");
  await browser.evaluate("document.querySelector('button[aria-label=\"New project\"]').click()");
  await browser.until("!!document.querySelector('dialog input[type=file]')");
  await field("Name", "Icon project");
  await upload(red);
  await browser.until(
    "document.querySelector('.project-icon-preview img')?.complete && ![...document.querySelectorAll('dialog button')].find(b=>b.textContent.trim()==='Create project').disabled",
  );
  await click("Create project");
  await browser.until(
    "!document.querySelector('dialog') && document.querySelector('.scope-switch img.project-icon')?.naturalWidth===128",
  );
  await browser.evaluate("document.querySelector('[aria-label=\"Search or jump\"]').click()");
  await browser.until("document.querySelector('.palette-result img')?.naturalWidth===128");
  await browser.evaluate("document.querySelector('[aria-label=\"Close search\"]').click()");
  const first = await browser.evaluate<string>(
    "document.querySelector('.scope-switch img.project-icon').src",
  );
  await browser.command("Page.reload");
  await browser.until(
    "document.querySelector('.scope-switch img.project-icon')?.naturalWidth===128",
  );
  if (
    (await browser.evaluate<string>(
      "document.querySelector('.scope-switch img.project-icon').src",
    )) !== first
  )
    throw new Error("Project icon did not persist");
  await browser.evaluate("document.querySelector('[aria-label=\"Edit project\"]').click()");
  await browser.until("!!document.querySelector('dialog input[type=file]')");
  await upload(invalid);
  await browser.until(
    "document.querySelector('dialog .error')?.textContent.includes('could not be opened')",
  );
  await upload(blue);
  await browser.until(
    "document.querySelector('.project-icon-preview img')?.src.startsWith('data:') && ![...document.querySelectorAll('dialog button')].find(b=>b.textContent.trim()==='Save changes').disabled",
  );
  for (const width of [390, 1440]) {
    await browser.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: width < 500,
    });
    const preview = await browser.command("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      join(tmpdir(), `allgather-icon-dialog-${width}.png`),
      Buffer.from(preview.data as string, "base64"),
    );
    if (await browser.evaluate("document.documentElement.scrollWidth>innerWidth"))
      throw new Error("Icon dialog overflows viewport");
  }
  await click("Save changes");
  await browser.until(
    `!document.querySelector('dialog') && document.querySelector('.scope-switch img.project-icon')?.src!==${JSON.stringify(first)} && document.querySelector('.scope-switch img.project-icon')?.naturalWidth===128`,
  );
  const replacement = await browser.evaluate<string>(
    "document.querySelector('.scope-switch img.project-icon').src",
  );
  await browser.evaluate("document.querySelector('[aria-label=\"Edit project\"]').click()");
  await browser.until("!!document.querySelector('dialog input[type=file]')");
  await click("Remove icon");
  await click("Cancel");
  await browser.until("!document.querySelector('dialog')");
  if (
    (await browser.evaluate<string>(
      "document.querySelector('.scope-switch img.project-icon').src",
    )) !== replacement
  )
    throw new Error("Cancelling changed the icon");
  const shot = await browser.command("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(tmpdir(), "allgather-project-icons.png"),
    Buffer.from(shot.data as string, "base64"),
  );
  await browser.evaluate("document.querySelector('[aria-label=\"Edit project\"]').click()");
  await browser.until("!!document.querySelector('dialog input[type=file]')");
  await click("Remove icon");
  await click("Save changes");
  await browser.until(
    "!document.querySelector('dialog') && !document.querySelector('.scope-switch img.project-icon')",
  );
  await browser.command("Page.reload");
  await browser.until(
    "!!document.querySelector('[aria-label=\"Project filter: Icon project\"] span.scope-mark')",
  );
  console.log(
    "Project icon browser verification passed: upload, resize, persistence, invalid input, replacement, cancellation, removal and responsive layouts.",
  );
} finally {
  await browser.close();
  await running.stop();
  rmSync(root, { recursive: true, force: true });
}
