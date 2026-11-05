import { BlockList, isIP } from "node:net";

export const defaultPrivateNetworks = [
  "127.0.0.0/8",
  "::1/128",
  "100.64.0.0/10",
  "fd7a:115c:a1e0::/48",
];

function address(value: string) {
  const normalized =
    value.startsWith("::ffff:") && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  return isIP(normalized) ? normalized : null;
}

export function networks(entries: string[]) {
  const list = new BlockList();
  for (const entry of entries) {
    const parts = entry.split("/"),
      ip = address(parts[0]);
    const version = ip && isIP(ip),
      bits = version === 4 ? 32 : 128;
    const prefix = parts.length === 1 ? bits : Number(parts[1]);
    if (
      !ip ||
      parts.length > 2 ||
      !/^\d+$/.test(parts[1] ?? String(bits)) ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > bits
    )
      throw new Error(`Invalid network range: ${entry}`);
    list.addSubnet(ip, prefix, version === 4 ? "ipv4" : "ipv6");
  }
  return (value: string) => {
    const ip = address(value);
    return !!ip && list.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
  };
}

export class NetworkBoundary {
  private trusted: ReturnType<typeof networks>;
  private private: ReturnType<typeof networks>;
  constructor(trustedProxies: string[], privateNetworks: string[]) {
    this.trusted = networks(trustedProxies);
    this.private = networks(privateNetworks);
  }
  client(peer: string, headers: Headers): string | null {
    let current = address(peer);
    if (!current || !this.trusted(current)) return current;
    const forwarded = headers.get("x-forwarded-for");
    if (!forwarded || forwarded.length > 2048) return null;
    const chain = forwarded.split(",").map((value) => address(value.trim()));
    if (chain.length > 16 || chain.some((value) => !value)) return null;
    for (let i = chain.length - 1; i >= 0 && this.trusted(current); i--) current = chain[i]!;
    return current;
  }
  allowsPrivate(client: string | null) {
    return client !== null && this.private(client);
  }
}

const publicRoutes = new Map<string, readonly string[]>([
  ["/mcp", ["GET", "POST", "DELETE", "OPTIONS"]],
  ["/.well-known/oauth-authorization-server", ["GET"]],
  ["/.well-known/oauth-protected-resource", ["GET"]],
  ["/.well-known/oauth-protected-resource/mcp", ["GET"]],
  ["/oauth/register", ["POST"]],
  ["/oauth/token", ["POST"]],
  ["/oauth/revoke", ["POST"]],
]);

export function isPublicRoute(request: Request) {
  return publicRoutes.get(new URL(request.url).pathname)?.includes(request.method) === true;
}
