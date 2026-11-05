import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import artifactPage from "../web/artifact.html";
import page from "../web/index.html";
import { createApp, Updates } from "./app.ts";
import { loadAssets } from "./assets.ts";
import { Auth, secret } from "./auth.ts";
import { backupWorkspace } from "./backup.ts";
import { type Config, config } from "./config.ts";
import { startLocalControl } from "./control.ts";
import { NativeGit } from "./native-git.ts";
import { openDatabase } from "./storage.ts";
import { Tower, type TowerSocketData } from "./tower.ts";
import { UpstreamSync } from "./upstream-sync.ts";
import { Workspace } from "./workspace.ts";

export async function startServer(overrides: Partial<Config> = {}) {
  const settings = config(overrides);
  mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
  const lock = join(settings.dataDir, "server.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    try {
      process.kill(pid, 0);
      throw new Error("An allgather server already owns this data directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      unlinkSync(lock);
    }
  }
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  let database: ReturnType<typeof openDatabase> | undefined;
  let upstream: UpstreamSync | undefined;
  let tower: Tower | undefined;
  let control: ReturnType<typeof startLocalControl> | undefined;
  let stopHttp: (() => Promise<void>) | undefined;
  try {
    const keyPath = join(settings.dataDir, "owner-key");
    if (!existsSync(keyPath) && existsSync(join(settings.dataDir, "allgather.sqlite")))
      throw new Error(
        "The owner key file is missing. Restore it from your backup before starting.",
      );
    if (!existsSync(keyPath)) writeFileSync(keyPath, secret(), { flag: "wx", mode: 0o600 });
    chmodSync(keyPath, 0o600);
    const ownerKey = readFileSync(keyPath, "utf8").trim();
    database = openDatabase(join(settings.dataDir, "allgather.sqlite"));
    const updates = new Updates(),
      workspace = new Workspace(
        database,
        undefined,
        () => {
          updates.emit();
          upstream?.wake();
          tower?.wake();
        },
        { dataDir: settings.dataDir, managedSessions: settings.managedSessions },
      );
    upstream = new UpstreamSync(
      workspace,
      new NativeGit(join(settings.dataDir, "git-cache")),
      settings.gitSyncSeconds,
    );
    const [mainAssets, artifactAssets] = await Promise.all([
      loadAssets(page),
      loadAssets(artifactPage, (path) => /^\/artifact-workspace\/[^/]+$/.test(path)),
    ]);
    const assets = (request: Request) => {
      const response = mainAssets(request);
      return response.status === 404 ? artifactAssets(request) : response;
    };
    const peers = new WeakMap<Request, string>();
    let app: ReturnType<typeof createApp> | undefined;
    const server = Bun.serve<TowerSocketData>({
      hostname: settings.hostname,
      port: settings.port,
      idleTimeout: 60,
      maxRequestBodySize: 200 * 1024 * 1024,
      fetch(request, server) {
        if (new URL(request.url).pathname.startsWith("/__r3_preview/"))
          return workspace.artifacts!.previews.fetch(request, new Set([settings.publicUrl]));
        if (new URL(request.url).pathname === "/tower") {
          const data = tower?.authenticate(request);
          if (!data) return new Response("Machine authentication required", { status: 401 });
          if (server.upgrade(request, { data })) return;
          return new Response("WebSocket upgrade required", { status: 426 });
        }
        peers.set(request, server.requestIP(request)?.address ?? "unknown");
        return app?.fetch(request) ?? new Response("Starting", { status: 503 });
      },
      websocket: {
        maxPayloadLength: 1024 * 1024,
        open: (socket) => tower?.open(socket),
        message: (socket, message) => tower?.message(socket, message),
        close: (socket) => tower?.close(socket),
      },
    });
    stopHttp = () => server.stop(true);
    const originalPort = settings.port;
    if (server.port === undefined) {
      await server.stop(true);
      throw new Error("The TCP listener has no port");
    }
    settings.port = server.port;
    if (originalPort === 0 && new URL(settings.publicUrl).port === "0") {
      const url = new URL(settings.publicUrl);
      url.port = String(settings.port);
      settings.publicUrl = url.origin;
    }
    try {
      const auth = new Auth(database, settings.publicUrl, ownerKey);
      tower = new Tower(workspace, settings.publicUrl, `${settings.hostname}:${settings.port}`);
      tower.start();
      const loginPath = join(settings.dataDir, "login-token");
      if (!existsSync(loginPath)) {
        const token = auth.createLoginToken("Server bootstrap");
        writeFileSync(loginPath, token.token, { mode: 0o600, flag: "wx" });
      } else {
        const token = readFileSync(loginPath, "utf8").trim();
        if (!auth.hasLoginToken(token)) auth.createLoginToken("Server bootstrap", token);
      }

      app = createApp(workspace, auth, updates, {
        assets,
        hostname: `${settings.hostname}:${settings.port}`,
        peer: (r) => peers.get(r) ?? "unknown",
        backup: () => backupWorkspace(workspace, ownerKey),
      });
    } catch (error) {
      await server.stop(true);
      throw error;
    }
    upstream.start();
    let closing: Promise<void> | undefined;
    const stop = () =>
      (closing ??= (async () => {
        control?.beginShutdown();
        await upstream?.stop();
        tower?.stop();
        workspace.artifacts?.previews.close();
        await server.stop(true);
        workspace.db.close();
        await control?.close();
        unlinkSync(lock);
      })());
    control = startLocalControl(settings, workspace, ownerKey, stop);
    console.log(
      `Allgather: ${settings.publicUrl}\nLogin token file: ${join(settings.dataDir, "login-token")}\nRecovery key file: ${keyPath}`,
    );
    return { server, workspace, stop, settings };
  } catch (error) {
    await upstream?.stop();
    tower?.stop();
    await control?.close();
    await stopHttp?.();
    database?.close();
    unlinkSync(lock);
    throw error;
  }
}
