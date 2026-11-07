import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, dataDirectory } from "../server/config.ts";
import { readServerConfig, serverConfigCommand } from "../server/server-config.ts";

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
