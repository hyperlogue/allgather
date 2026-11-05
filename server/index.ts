import {
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
import { Auth } from "./auth.ts";
import { backupWorkspace } from "./backup.ts";
import { type Config, config } from "./config.ts";
import { startLocalControl } from "./control.ts";
import { NativeGit } from "./native-git.ts";
import { listenerRejection, NetworkBoundary } from "./network.ts";
import { openDatabase } from "./storage.ts";
import { Tower, type TowerSocketData } from "./tower.ts";
import { UpstreamSync } from "./upstream-sync.ts";
import { Workspace } from "./workspace.ts";

export async function startServer(overrides: Partial<Config> = {}) {
  const settings = config(overrides);
  const ownerNetwork = new NetworkBoundary(settings.ownerTrustedProxies, settings.privateNetworks);
  const mcpNetwork = new NetworkBoundary(settings.mcpTrustedProxies, []);
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
    database = openDatabase(join(settings.dataDir, "allgather.sqlite"));
    for (const name of ["owner-key", "login-token"]) {
      const path = join(settings.dataDir, name);
      if (existsSync(path)) unlinkSync(path);
    }
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
    let publicApp: ReturnType<typeof createApp> | undefined;
    let mcpServer: Bun.Server<undefined> | undefined;
    const server = Bun.serve<TowerSocketData>({
      hostname: settings.hostname,
      port: settings.port,
      idleTimeout: 60,
      maxRequestBodySize: 200 * 1024 * 1024,
      fetch(request, server) {
        const rejected = listenerRejection(request, settings.ownerUrl, "private");
        if (rejected) return rejected;
        const peer = ownerNetwork.client(server.requestIP(request)?.address ?? "", request.headers);
        if (!ownerNetwork.allowsPrivate(peer))
          return new Response("Private network required", { status: 403 });
        peers.set(request, peer!);
        if (new URL(request.url).pathname.startsWith("/__r3_preview/"))
          return workspace.artifacts!.previews.fetch(request, new Set([settings.ownerUrl]));
        if (new URL(request.url).pathname === "/tower") {
          const data = tower?.authenticate(request);
          if (!data) return new Response("Machine authentication required", { status: 401 });
          if (server.upgrade(request, { data })) return;
          return new Response("WebSocket upgrade required", { status: 426 });
        }
        return app?.fetch(request) ?? new Response("Starting", { status: 503 });
      },
      websocket: {
        maxPayloadLength: 1024 * 1024,
        open: (socket) => tower?.open(socket),
        message: (socket, message) => tower?.message(socket, message),
        close: (socket) => tower?.close(socket),
      },
    });
    stopHttp = async () => {
      await mcpServer?.stop(true);
      await server.stop(true);
    };
    const originalPort = settings.port;
    if (server.port === undefined) {
      await server.stop(true);
      throw new Error("The TCP listener has no port");
    }
    settings.port = server.port;
    if (originalPort === 0 && new URL(settings.ownerUrl).port === "0") {
      const url = new URL(settings.ownerUrl);
      url.port = String(settings.port);
      settings.ownerUrl = url.origin;
    }
    try {
      if (settings.mcpUrl && settings.mcpPort !== null) {
        mcpServer = Bun.serve({
          hostname: settings.mcpHostname,
          port: settings.mcpPort,
          idleTimeout: 60,
          maxRequestBodySize: 32 * 1024 * 1024,
          fetch(request, server) {
            const rejected = listenerRejection(request, settings.mcpUrl!, "public");
            if (rejected) return rejected;
            const peer = mcpNetwork.client(
              server.requestIP(request)?.address ?? "",
              request.headers,
            );
            if (!peer) return new Response("Invalid proxy chain", { status: 403 });
            peers.set(request, peer);
            return publicApp?.fetch(request) ?? new Response("Starting", { status: 503 });
          },
        });
        settings.mcpPort = mcpServer.port!;
        if (new URL(settings.mcpUrl).port === "0") {
          const url = new URL(settings.mcpUrl);
          url.port = String(settings.mcpPort);
          settings.mcpUrl = url.origin;
        }
      }
      const auth = new Auth(database, settings.ownerUrl, settings.mcpUrl ?? settings.ownerUrl);
      tower = new Tower(workspace, settings.ownerUrl);
      tower.start();
      app = createApp(workspace, auth, updates, {
        assets,
        peer: (r) => peers.get(r) ?? "unknown",
        backup: () => backupWorkspace(workspace),
      });
      if (mcpServer)
        publicApp = createApp(workspace, auth, updates, {
          surface: "public",
          peer: (r) => peers.get(r) ?? "unknown",
        });
    } catch (error) {
      await stopHttp();
      throw error;
    }
    workspace.approvals.recover();
    upstream.start();
    workspace.transcripts.start();
    let closing: Promise<void> | undefined;
    const stop = () =>
      (closing ??= (async () => {
        control?.beginShutdown();
        workspace.approvals.close();
        await workspace.transcripts.stop();
        await upstream?.stop();
        tower?.stop();
        workspace.artifacts?.previews.close();
        await stopHttp!();
        workspace.db.close();
        await control?.close();
        unlinkSync(lock);
      })());
    control = startLocalControl(settings, workspace, stop);
    console.log(
      `Allgather: ${settings.ownerUrl}\nSign in with a one-time code from: allgather-server auth create-token --data-dir ${settings.dataDir}`,
    );
    return { server, mcpServer, workspace, stop, settings };
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
