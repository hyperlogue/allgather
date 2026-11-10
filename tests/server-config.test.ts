import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, dataDirectory } from "../server/config.ts";
import { readServerConfig, serverConfigCommand } from "../server/server-config.ts";
import { migrateClientConfig } from "../shared/local-config.ts";

test("server configuration precedence is flags, environment, saved values, then defaults", () => {
  const saved = {
    port: 4400,
    ownerUrl: "https://private.example",
    mcpUrl: "https://mcp.example",
    mcpTrustedProxies: ["127.0.0.1/32"],
    managedSessions: false,
    gitSyncSeconds: 600,
  };
  expect(config({}, saved, {})).toMatchObject(saved);
  expect(
    config({ port: 4600, managedSessions: false }, saved, {
      ALLGATHER_PORT: "4500",
      ALLGATHER_MANAGED_SESSIONS: "true",
    }),
  ).toMatchObject({ port: 4600, managedSessions: false });
  expect(
    config({}, saved, { ALLGATHER_PORT: "4500", ALLGATHER_MANAGED_SESSIONS: "true" }),
  ).toMatchObject({ port: 4500, managedSessions: true });
  expect(
    config({ mcpUrl: null }, saved, { ALLGATHER_MCP_URL: "https://other.example" }).mcpUrl,
  ).toBeNull();
  expect(() => config({}, saved, { ALLGATHER_MCP_TRUSTED_PROXIES: "" })).toThrow(
    "MCP_TRUSTED_PROXIES",
  );
  expect(config({}, {}, {}).port).toBe(4390);
  expect(config({}, {}, {}).ownerUrl).toBe("http://localhost:4390");
  expect(
    dataDirectory(undefined, { dataDir: "/fixture/saved" }, { ALLGATHER_DATA_DIR: "/fixture/env" }),
  ).toBe("/fixture/env");
});

test("server config writes validate complete changes atomically and never replace invalid files", () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-config-")),
    path = join(root, "server.json");
  const cmd = (...args: string[]) => serverConfigCommand(args, path);
  try {
    expect(readServerConfig(path)).toBeNull();
    cmd(
      "set",
      "ownerUrl",
      "https://owner.example",
      "mcpUrl",
      "https://mcp.example",
      "mcpTrustedProxies",
      "127.0.0.1/32",
      "ownerTrustedProxies",
      '["::1/128"]',
    );
    expect(readServerConfig(path)).toMatchObject({
      ownerUrl: "https://owner.example",
      mcpTrustedProxies: ["127.0.0.1/32"],
      ownerTrustedProxies: ["::1/128"],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const before = readFileSync(path, "utf8");
    for (const args of [
      ["set", "port", "no"],
      ["set", "dataDir", ""],
      ["set", "port", "70000"],
      ["set", "managedSessions", "maybe"],
      ["set", "ownerKey", "secret"],
      ["set", "ownerUrl", "http://remote.example"],
      ["set", "privateNetworks", "no"],
      ["unset", "mcpTrustedProxies"],
    ]) {
      expect(() => cmd(...args)).toThrow();
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    cmd("unset", "mcpUrl", "mcpTrustedProxies");
    expect(readServerConfig(path)).not.toHaveProperty("mcpUrl");
    cmd("set", "mcpUrl", "null");
    expect(cmd("get", "mcpUrl")).toBeNull();
    writeFileSync(path, JSON.stringify({ dataDir: "data" }));
    expect(readServerConfig(path)?.dataDir).toBe(join(root, "data"));
    for (const invalid of ['{"port":', '{"port":"4390"}', '{"trustedProxies":["127.0.0.1"]}']) {
      writeFileSync(path, invalid);
      expect(() => readServerConfig(path)).toThrow();
      expect(() => cmd("set", "port", "4390")).toThrow();
      expect(readFileSync(path, "utf8")).toBe(invalid);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy client selection migrates without replacing newer client or server settings", () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-config-migration-"));
  const server = join(root, "server.json"),
    client = join(root, "client.json");
  try {
    writeFileSync(server, JSON.stringify({ url: "https://old.example" }));
    expect(readServerConfig(server)).toBeNull();
    expect(JSON.parse(readFileSync(client, "utf8"))).toEqual({ url: "https://old.example" });
    expect(statSync(client).mode & 0o777).toBe(0o600);
    writeFileSync(client, JSON.stringify({ url: "https://new.example" }));
    expect(readServerConfig(server)).toBeNull();
    expect(JSON.parse(readFileSync(client, "utf8"))).toEqual({ url: "https://new.example" });
    serverConfigCommand(["set", "ownerUrl", "https://owner.example"], server);
    const before = readFileSync(server, "utf8");
    migrateClientConfig(root);
    expect(readFileSync(server, "utf8")).toBe(before);
    expect(readServerConfig(server)?.ownerUrl).toBe("https://owner.example");
    expect(JSON.parse(readFileSync(client, "utf8"))).toEqual({ url: "https://new.example" });
    writeFileSync(
      server,
      JSON.stringify({ ownerUrl: "https://owner.example", url: "https://old.example" }),
    );
    expect(() => readServerConfig(server)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive retention is configurable, bounded, and persists across config reads", () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-retention-")),
    path = join(root, "server.json");
  try {
    serverConfigCommand(["set", "archiveTtlDays", "7"], path);
    const saved = readServerConfig(path)!;
    expect(config({}, saved, {}).archiveTtlDays).toBe(7);
    expect(config({}, saved, { ALLGATHER_ARCHIVE_TTL_DAYS: "14" }).archiveTtlDays).toBe(14);
    expect(
      config({ archiveTtlDays: 21 }, saved, { ALLGATHER_ARCHIVE_TTL_DAYS: "14" }).archiveTtlDays,
    ).toBe(21);
    for (const invalid of ["0", "36501", "1.5"])
      expect(() => serverConfigCommand(["set", "archiveTtlDays", invalid], path)).toThrow();
    expect(readServerConfig(path)?.archiveTtlDays).toBe(7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
