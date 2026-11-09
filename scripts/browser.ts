import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function browserSession(executable: string) {
  const profile = await mkdtemp(join(tmpdir(), "allgather-browser-"));
  const child = Bun.spawn(
    [
      executable,
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: profile,
        XDG_CONFIG_HOME: join(profile, "config"),
        XDG_CACHE_HOME: join(profile, "cache"),
        XDG_STATE_HOME: join(profile, "state"),
      },
    },
  );
  const errors = new Response(child.stderr).text();
  let socket: WebSocket | undefined;
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const close = async () => {
    socket?.close();
    if (child.exitCode === null) child.kill();
    await child.exited;
    await errors;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Browser closed"));
    }
    pending.clear();
    await rm(profile, { recursive: true, force: true });
  };
  try {
    let port = "";
    for (let n = 0; n < 300; n++) {
      if (child.exitCode !== null)
        throw new Error(`Chromium exited: ${(await errors).slice(0, 2000)}`);
      try {
        port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    if (!port) throw new Error("Chromium did not start");
    const info = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const connection = new WebSocket(info.webSocketDebuggerUrl);
    socket = connection;
    await new Promise<void>((resolve, reject) => {
      connection.onopen = () => resolve();
      connection.onerror = () => reject(new Error("Browser connection failed"));
    });
    socket.onmessage = (event) => {
      const data = JSON.parse(String(event.data)),
        item = pending.get(data.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(data.id);
      if (data.error) item.reject(new Error(data.error.message));
      else item.resolve(data.result);
    };
    const send = (
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, {
          resolve,
          reject,
          timer: setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Browser timeout: ${method}`));
          }, 15000),
        });
        connection.send(JSON.stringify({ id, method, params, sessionId }));
      });
    const target = await send("Target.createTarget", { url: "about:blank" });
    const attached = await send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const command = (method: string, params: Record<string, unknown> = {}) =>
      send(method, params, attached.sessionId as string);
    await command("Page.enable");
    await command("Runtime.enable");
    const evaluate = async <T>(expression: string): Promise<T> => {
      const r = await command("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return (r.result as { value: T }).value;
    };
    const until = async (expression: string) => {
      for (let n = 0; n < 100; n++) {
        if (await evaluate(expression)) return;
        await Bun.sleep(100);
      }
      throw new Error(`Browser condition failed: ${expression}`);
    };
    return { command, evaluate, until, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function browserPasskeyLogin(
  browser: Awaited<ReturnType<typeof browserSession>>,
  loginUrl: string,
  target?: string,
) {
  const prior = target ?? (await browser.evaluate<string>("location.href"));
  await browser.command("WebAuthn.enable");
  await browser.command("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await browser.command("Page.navigate", { url: loginUrl });
  await browser.until(
    `document.querySelector('.login-enter')?.textContent==='Create passkey and enter'`,
  );
  if (await browser.evaluate("location.hash!==''"))
    throw new Error("Registration secret remains in the URL");
  await browser.evaluate("document.querySelector('.login-enter').click()");
  await browser.until(
    `!!document.querySelector('.app-header') || !!document.querySelector('.login .error')`,
  );
  const failure = await browser.evaluate<string | null>(
    "document.querySelector('.login .error')?.textContent ?? null",
  );
  if (failure) throw new Error(`Browser passkey registration: ${failure}`);
  if (prior.startsWith(new URL(loginUrl).origin) && !prior.includes("/welcome")) {
    await browser.command("Page.navigate", { url: prior });
    await browser.until(`!!document.querySelector('.app-header')`);
  }
}
