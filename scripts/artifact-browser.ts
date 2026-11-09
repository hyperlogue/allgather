import { browserPasskeyLogin, browserSession } from "./browser.ts";
/** Exercise the actual artifact bundle, sandbox handshake, and review composer. */
export async function verifyArtifactBrowser(
  executable: string,
  origin: string,
  loginUrl: string,
  id: string,
) {
  const b = await browserSession(executable);
  try {
    await b.command("Page.addScriptToEvaluateOnNewDocument", {
      source:
        "window.testErrors=[];addEventListener('error',e=>testErrors.push(e.message));addEventListener('unhandledrejection',e=>testErrors.push(String(e.reason)));",
    });
    await b.command("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.command("Page.navigate", { url: origin });
    await browserPasskeyLogin(b, loginUrl);
    await b.until(`!!document.querySelector('.app-header')`);
    await b.evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='Settings').click()`,
    );
    await b.until(`!!document.querySelector('input[name="theme"][value="dark"]')`);
    await b.evaluate(`document.querySelector('input[name="theme"][value="dark"]').click()`);
    await b.command("Page.navigate", { url: `${origin}/artifact-workspace/${id}` });
    await b.until(`document.documentElement.classList.contains('dark')`);
    await b.until(
      `!!document.querySelector('[aria-label="Capture area"]')||!![...document.querySelectorAll('button')].find(b=>b.textContent==='Accept risk and continue')`,
    );
    await b.evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='Accept risk and continue')?.click()`,
    );
    await b.until(`!!document.querySelector('[aria-label="Capture area"]')`);
    const sandbox = await b.evaluate<string>(
      `document.querySelector('iframe')?.getAttribute('sandbox')`,
    );
    if (sandbox !== "allow-scripts") throw new Error("Preview sandbox gained extra authority");
    await b.evaluate(`document.querySelector('[aria-label="Add comment"]').click()`);
    await b.until(`!!document.querySelector('textarea[aria-label="Comment"]')`);
    await b.evaluate(`document.querySelector('textarea[aria-label="Comment"]').focus()`);
    await b.command("Input.insertText", { text: "Keep this evidence linked to the task." });
    await b.evaluate(
      `document.querySelector('textarea[aria-label="Comment"]').form.requestSubmit()`,
    );
    await b.until(
      `document.body.innerText.includes('Keep this evidence linked to the task.')&&!document.querySelector('textarea[aria-label="Comment"]')`,
    );
    await b.until(
      `[...document.querySelectorAll('[data-artifact-handoff]')].some(b=>!b.disabled&&!b.closest('[inert]')&&b.getClientRects().length)`,
    );
    await b.evaluate(
      `[...document.querySelectorAll('[data-artifact-handoff]')].find(b=>!b.disabled&&!b.closest('[inert]')&&b.getClientRects().length).click()`,
    );
    try {
      await b.until(
        `[...document.querySelectorAll('[popover] code')].some(c=>c.textContent===${JSON.stringify("allgather artifact comments " + id)})`,
      );
    } catch (e) {
      console.log(
        await b.evaluate(
          `({text:document.body.innerText.slice(0,4000),button:document.querySelector('[data-artifact-handoff]')?.outerHTML,errors:window.testErrors})`,
        ),
      );
      throw e;
    }
    await b.command("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await b.command("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    for (const width of [1024, 390]) {
      await b.command("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width < 500,
      });
      await b.until(`document.documentElement.scrollWidth<=innerWidth+1`);
    }
    const errors = await b.evaluate<string[]>("window.testErrors");
    if (errors.length) throw new Error(errors.join("\n"));
  } finally {
    await b.close();
  }
}
