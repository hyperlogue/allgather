import { expect, test } from "bun:test";
import { parse } from "../cli/args.ts";
import { detectOperator } from "../cli/operator.ts";

test("operator detection prefers explicit context and rejects ambiguous inherited harness sessions", () => {
  expect(detectOperator({})).toEqual({ operator_kind: "user", operator_source: "explicit" });
  expect(detectOperator({ CODEX_THREAD_ID: "example-run" })).toMatchObject({
    operator_kind: "agent",
    agent_type: "codex",
    session_id: "codex:example-run",
    operator_source: "cli_environment",
  });
  const inherited = { CODEX_THREAD_ID: "outer", CLAUDE_SESSION_ID: "inner" };
  expect(() => detectOperator(inherited)).toThrow("Multiple harness sessions");
  expect(detectOperator(inherited, "claude")).toMatchObject({
    agent_type: "claude",
    session_id: "claude:inner",
  });
  expect(
    detectOperator(inherited, undefined, {
      operator_name: "Reviewer",
      agent_type: "custom",
      session_id: "review-run",
    }),
  ).toMatchObject({
    operator_kind: "agent",
    operator_name: "Reviewer",
    session_id: "review-run",
    agent_type: "custom",
    operator_source: "explicit",
  });
  expect(detectOperator(inherited, "codex", { operator_kind: "user" }).operator_kind).toBe("user");
  expect(
    detectOperator({ ALLGATHER_OPERATOR_KIND: "user" }, undefined, { operator_kind: "agent" })
      .operator_kind,
  ).toBe("agent");
  expect(detectOperator({ CODEX_THREAD_ID: "outer" }, "claude")).toMatchObject({
    agent_type: "claude",
  });
  expect(detectOperator({ CODEX_THREAD_ID: "outer" }, "claude").session_id).toBeUndefined();
});

test("force resume requires an explicit true CLI flag", () => {
  expect(parse(["session", "resume", "session", "--force"]).flags.force).toBe(true);
  expect(parse(["session", "resume", "session", "--force=false"]).flags.force).toBe(false);
  expect(parse(["session", "resume", "session"]).flags.force).toBeUndefined();
  expect(() => parse(["session", "resume", "session", "--force=maybe"])).toThrow("true or false");
});
