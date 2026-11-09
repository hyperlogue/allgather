import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fixtureApiToken, fixtureLogin, fixtureLoginToken } from "./fixture-auth.ts";

const executable = resolve(process.argv[2] ?? "dist/allgather");
const daemon = join(dirname(executable), "allgather-server");
const directory = mkdtempSync(join(tmpdir(), "allgather-package-"));
const isolatedEnv = {
  ...process.env,
  HOME: directory,
  XDG_CONFIG_HOME: directory,
  XDG_STATE_HOME: directory,
  ALLGATHER_CONFIG_DIR: join(directory, "config"),
  ALLGATHER_GIT_SYNC_SECONDS: "0",
};
const daemonCommand = async (...args: string[]) => {
  const child = Bun.spawn(
    [
      daemon,
      ...args,
      ...(args[0] === "config" || args.includes("--data-dir")
        ? []
        : ["--data-dir", join(directory, "state")]),
      "--json",
    ],
    {
      cwd: directory,
      env: isolatedEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(err);
  return JSON.parse(out) as {
    gateways?: import("../server/gateways.ts").GatewayStatus[];
    state?: string;
    instance?: string;
    saved?: boolean;
    restored?: boolean;
    settings: import("../server/config.ts").Config;
  };
};
const server = Bun.spawn(
  [
    daemon,
    "run",
    "--data-dir",
    join(directory, "state"),
    "--port",
    "0",
    "--owner-url",
    "http://127.0.0.1:0",
  ],
  { cwd: directory, env: isolatedEnv, stdout: "pipe", stderr: "pipe" },
);
try {
  const reader = server.stdout.getReader();
  let output = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const origin = await Promise.race([
    (async () => {
      while (true) {
        const part = await reader.read();
        if (part.done) throw new Error(await new Response(server.stderr).text());
        output += new TextDecoder().decode(part.value);
        const match = /^Allgather: (https?:\/\/[^\n]+)$/m.exec(output);
        if (match) return match[1];
      }
    })(),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Packaged server did not start")), 20000);
    }),
  ]).finally(() => clearTimeout(timeout));
  for (const route of ["/", "/oauth/authorize"]) {
    const response = await fetch(origin + route);
    if (!response.ok) throw new Error(`Document failed: ${route}`);
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]);
    if (assets.length < 2) throw new Error("Browser assets are missing");
    for (const asset of assets) {
      const result = await fetch(new URL(asset, origin + route));
      if (!result.ok) throw new Error(`Bundled asset failed at ${route}`);
    }
  }
  const key = await fixtureApiToken(origin, await fixtureLogin(join(directory, "state"), origin));
  const invoke = async (...args: string[]) => {
    const child = Bun.spawn([executable, ...args, "--json"], {
      cwd: directory,
      env: {
        ...isolatedEnv,
        ALLGATHER_URL: origin,
        ALLGATHER_TOKEN: key,
        ALLGATHER_CONFIG_DIR: join(directory, "config"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(err);
    return JSON.parse(out) as { id: string; status?: string; is_done?: boolean };
  };
  const guide = await invoke("guide");
  if (!(guide as { workflow?: string }).workflow?.includes("context"))
    throw new Error("Packaged guide is missing");
  const project = await invoke("project", "create", "--name", "Package verification");
  const task = await invoke(
    "task",
    "create",
    "--project",
    project.id,
    "--title",
    "Standalone workflow",
  );
  const completed = await invoke("task", "resolve", task.id);
  if (completed.status !== "closed" || !completed.is_done)
    throw new Error("Packaged CLI did not complete the task");
  const artifact = await invoke(
    "artifact",
    "create",
    "--kind",
    "html",
    "--title",
    "Packaged capture",
    "--project",
    project.id,
    "--operator-kind",
    "user",
  );
  const capture = join(directory, "capture");
  mkdirSync(capture);
  writeFileSync(join(capture, "index.html"), "<h1>Packaged artifact</h1><p>Retained evidence.</p>");
  await invoke("artifact", "publish", artifact.id, "--root", capture, "--no-listen");
  const source = await fetch(
    `${origin}/api/artifacts/${artifact.id}/versions/1/source?path=index.html`,
    { headers: { authorization: `Bearer ${key}` } },
  );
  if (!source.ok) throw new Error(`Packaged source rendering failed: ${await source.text()}`);
  await source.arrayBuffer();
  if (process.env.ALLGATHER_TEST_BROWSER) {
    const { verifyArtifactBrowser } = await import("./artifact-browser.ts");
    await verifyArtifactBrowser(
      process.env.ALLGATHER_TEST_BROWSER,
      origin,
      await fixtureLoginToken(join(directory, "state")),
      artifact.id,
    );
  }
  server.kill("SIGTERM");
  if (await server.exited) throw new Error("Foreground server did not stop cleanly");
  if ((await daemonCommand("status")).state !== "stopped")
    throw new Error("Foreground ownership remained");
  mkdirSync(join(directory, "config"), { recursive: true });
  writeFileSync(join(directory, "config", "server.json"), JSON.stringify({ url: origin }));
  await daemonCommand(
    "config",
    "set",
    "dataDir",
    join(directory, "state"),
    "port",
    "0",
    "ownerUrl",
    "http://127.0.0.1:0",
    "mcpUrl",
    "http://127.0.0.1:0",
    "mcpPort",
    "0",
    "gateways",
    JSON.stringify([
      {
        name: "fixture",
        command: [process.execPath, "--no-env-file", "-e", "setInterval(()=>{},1000)"],
      },
    ]),
  );
  const waitForGateway = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = (await daemonCommand("status")).gateways?.[0];
      if (row?.state === "running" && row.pid) return row.pid;
      await Bun.sleep(50);
    }
    throw new Error("Packaged gateway did not start");
  };
  const assertStopped = (pid: number) => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    throw new Error("Packaged gateway survived shutdown");
  };
  const started = await daemonCommand("start");
  if (started.state !== "running") throw new Error("Packaged background server did not start");
  const firstGateway = await waitForGateway();
  if (
    !started.settings.mcpUrl ||
    (await fetch(started.settings.mcpUrl + "/api/session")).status !== 404
  )
    throw new Error("Packaged public listener exposed owner API");
  await daemonCommand(
    "config",
    "set",
    "port",
    String(started.settings.port),
    "ownerUrl",
    started.settings.ownerUrl,
    "mcpPort",
    String(started.settings.mcpPort),
    "mcpUrl",
    started.settings.mcpUrl!,
  );
  const restarted = await daemonCommand("restart");
  assertStopped(firstGateway);
  const replacementGateway = await waitForGateway();
  if (firstGateway === replacementGateway) throw new Error("Gateway was not replaced on restart");
  if (JSON.stringify(restarted.settings) !== JSON.stringify(started.settings))
    throw new Error("Packaged restart changed listener settings");
  if (restarted.state !== "running" || restarted.instance === started.instance)
    throw new Error("Packaged background restart did not replace the instance");
  if (!(await daemonCommand("backup", join(directory, "backup.zip"))).saved)
    throw new Error("Packaged backup failed");
  if (
    !(
      await daemonCommand(
        "restore",
        join(directory, "backup.zip"),
        "--data-dir",
        join(directory, "restored"),
      )
    ).restored
  )
    throw new Error("Packaged ZIP restore failed");
  if ((await daemonCommand("stop")).state !== "stopped") throw new Error("Packaged stop failed");
  assertStopped(replacementGateway);
  console.log(
    "Standalone packages passed: HTTP client, offline guide, foreground/background lifecycle, restart, local backup, embedded browser assets, OAuth document, task workflow, artifact capture, and source rendering.",
  );
} finally {
  if (server.exitCode === null) server.kill("SIGTERM");
  await server.exited;
  await daemonCommand("stop").catch(() => {});
  rmSync(directory, { recursive: true, force: true });
}
