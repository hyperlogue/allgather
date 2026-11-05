import { readFileSync } from "node:fs";
import { basename } from "node:path";

export interface OperatorMetadata {
  operator_kind: "user" | "agent";
  operator_name?: string;
  agent_type?: string;
  session_id?: string;
  operator_source: "explicit" | "cli_environment" | "cli_process_tree";
}
export function detectOperator(
  env: Record<string, string | undefined>,
  ancestor?: string,
  overrides: Partial<OperatorMetadata> = {},
): OperatorMetadata {
  if ((overrides.operator_kind ?? env.ALLGATHER_OPERATOR_KIND) === "user")
    return {
      operator_kind: "user",
      operator_source: "explicit",
      ...(overrides.session_id ? { session_id: overrides.session_id } : {}),
    };
  const candidates = [
    { type: "codex", session: env.CODEX_THREAD_ID || env.CODEX_SESSION_ID },
    { type: "claude", session: env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID },
    { type: "antigravity", session: env.ANTIGRAVITY_CONVERSATION_ID },
  ].filter((c) => c.session?.trim());
  const explicit = overrides.session_id || env.ALLGATHER_SESSION?.trim();
  const typeOverride = overrides.agent_type || env.ALLGATHER_AGENT_TYPE?.trim();
  const chosen =
    candidates.find((c) => c.type === (typeOverride || ancestor)) ??
    (!typeOverride && !ancestor && candidates.length === 1 ? candidates[0] : undefined);
  if (candidates.length > 1 && !chosen && !explicit)
    throw new Error(
      "Multiple harness sessions are visible. Set ALLGATHER_SESSION and ALLGATHER_AGENT_TYPE explicitly.",
    );
  const type = typeOverride || chosen?.type || ancestor;
  const session =
    explicit || (chosen?.session ? `${chosen.type}:${chosen.session.trim()}` : undefined);
  const name = overrides.operator_name || env.ALLGATHER_OPERATOR_NAME?.trim();
  const isAgent = !!(
    session ||
    type ||
    name ||
    overrides.operator_kind === "agent" ||
    env.ALLGATHER_OPERATOR_KIND === "agent"
  );
  if (!isAgent) return { operator_kind: "user", operator_source: "explicit" };
  return {
    operator_kind: "agent",
    operator_name:
      name ||
      (session
        ? `${type || "Agent"}:${session.startsWith(`${type}:`) ? session.slice((type?.length ?? 0) + 1) : session}`
        : type || "Agent"),
    ...(type ? { agent_type: type } : {}),
    ...(session ? { session_id: session } : {}),
    operator_source:
      explicit || name || typeOverride
        ? "explicit"
        : chosen
          ? "cli_environment"
          : "cli_process_tree",
  };
}
function harness(value: string) {
  const name = basename(value).toLowerCase();
  if (name.includes("sandbox")) return undefined;
  if (/^(codex|codex-cli)(?:$|[-.])/.test(name)) return "codex";
  if (/^(claude|claude-code)(?:$|[-.])/.test(name)) return "claude";
  if (/^(antigravity|agy)(?:$|[-.])/.test(name)) return "antigravity";
  return undefined;
}
export function ancestorHarness(): string | undefined {
  // Inspect command identities only. Full arguments and environment never leave this process.
  if (process.platform !== "linux") return undefined;
  let pid = process.ppid;
  const seen = new Set<number>();
  for (let depth = 0; pid > 1 && depth < 32 && !seen.has(pid); depth++) {
    seen.add(pid);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8"),
        start = stat.indexOf("("),
        end = stat.lastIndexOf(")");
      const argv0 = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0", 1)[0] ?? "";
      const found = harness(argv0);
      if (found) return found;
      // The argv identity distinguishes an agent from a similarly named sandbox helper.
      if (!argv0) {
        const named = harness(stat.slice(start + 1, end));
        if (named) return named;
      }
      pid = Number(stat.slice(end + 2).split(/\s+/)[1]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
export function currentOperator(overrides: Partial<OperatorMetadata> = {}) {
  return detectOperator(process.env, ancestorHarness(), overrides);
}
