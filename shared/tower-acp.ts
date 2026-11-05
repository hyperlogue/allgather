import { z } from "zod";

export const wireId = z.string().min(1).max(160);
const harnessCapability = z.enum([
  "prompt",
  "resume",
  "permission_reply",
  "elicitation_reply",
  "configure",
  "image_input",
  "audio_input",
  "resource_input",
]);
export const harnessControlSchema = z
  .object({
    protocol: z.enum(["codex-app-server", "acp"]),
    capabilities: z
      .array(harnessCapability)
      .max(8)
      .refine((v) => new Set(v).size === v.length),
    cancel_mode: z.enum(["turn", "runtime"]).nullable(),
  })
  .strict();
export const terminalControlSchema = z
  .object({
    protocol: z.literal("terminal"),
    capabilities: z.array(harnessCapability).length(0),
    cancel_mode: z.literal("runtime"),
  })
  .strict();
export const terminalControlsSchema = z
  .record(wireId, terminalControlSchema)
  .refine((v) => Object.keys(v).length <= 30);
export const sessionControlSchema = z.union([harnessControlSchema, terminalControlSchema]);
export type TerminalControls = z.infer<typeof terminalControlSchema>;
export type SessionControls = z.infer<typeof sessionControlSchema>;
export const terminalStateSchema = z
  .object({
    state: z.enum(["starting", "running", "ended", "error"]),
    owner_id: wireId.optional(),
    tower_session_id: wireId.optional(),
    native_session_id: wireId.optional(),
    controls: terminalControlSchema.optional(),
    termination: z.enum(["confirmed", "unknown"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (["ended", "error"].includes(value.state) && value.termination !== "confirmed")
      ctx.addIssue({ code: "custom", message: "Ambiguous terminal loss must use runtime.lost" });
  });
export type HarnessControls = z.infer<typeof harnessControlSchema>;
export const harnessControlsSchema = z
  .record(wireId, harnessControlSchema)
  .refine(
    (v) => Object.keys(v).length <= 30 && (!v.codex || v.codex.protocol === "codex-app-server"),
  );
export function intersectControls(
  bound: SessionControls | null,
  current: SessionControls | null | undefined,
): SessionControls | null {
  if (!bound || !current || bound.protocol !== current.protocol) return null;
  if (bound.protocol === "terminal")
    return { protocol: "terminal", capabilities: [], cancel_mode: "runtime" };
  return {
    protocol: bound.protocol,
    capabilities: bound.capabilities.filter((c) => current.capabilities.includes(c)),
    cancel_mode: bound.cancel_mode === current.cancel_mode ? bound.cancel_mode : null,
  };
}
export function narrowsControls(bound: SessionControls | null, next: SessionControls) {
  return (
    !!bound &&
    bound.protocol === next.protocol &&
    next.capabilities.every((c) => bound.capabilities.includes(c)) &&
    (next.cancel_mode === null || next.cancel_mode === bound.cancel_mode)
  );
}
export function acceptsPrompt(controls: SessionControls | null, content: unknown): boolean {
  if (!controls?.capabilities.includes("prompt") || !Array.isArray(content)) return false;
  return content.every((b) => {
    if (!b || typeof b !== "object") return false;
    if (b.type === "text") return typeof b.text === "string" && !b.asset_id;
    const feature = (
      {
        image: "image_input",
        audio: "audio_input",
        resource: "resource_input",
        resource_link: "resource_input",
      } as const
    )[b.type as "image" | "audio" | "resource" | "resource_link"];
    return !!feature && controls.capabilities.includes(feature);
  });
}
const revision = z.number().int().safe().nonnegative();
export const runtimeIdentity = z.object({ runtime_id: wireId, generation: wireId }).strict();
export const resumeCleanupSchema = z
  .array(runtimeIdentity)
  .min(1)
  .max(32)
  .refine((targets) => new Set(targets.map((target) => target.runtime_id)).size === targets.length);
export const receiptSchema = runtimeIdentity
  .extend({
    command_id: wireId,
    receipt_revision: revision,
    state: z.enum(["missing", "pending", "dispatching", "accepted", "failed", "unknown"]),
    acceptance: z
      .object({ level: z.enum(["adapter", "harness"]), at: z.iso.datetime({ offset: true }) })
      .strict()
      .optional(),
    dispatch: z
      .object({
        state: z.enum(["not_started", "in_flight", "finished", "unknown"]),
        transport_written: z.boolean().optional(),
      })
      .strict(),
    result: z
      .object({
        tower_session_id: wireId.optional(),
        acp_session_id: wireId.optional(),
        native_session_id: wireId.optional(),
        owner_id: wireId.optional(),
        outcome: z.enum(["completed", "cancelled", "rejected", "configured", "stopped"]).optional(),
      })
      .strict()
      .optional(),
    error: z
      .object({
        code: wireId,
        message: z.string().max(1000),
        stage: z.enum(["admission", "dispatch", "execution", "recovery"]),
        may_have_effect: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.state === "accepted") !== !!v.acceptance)
      ctx.addIssue({ code: "custom", message: "Only accepted receipts carry acceptance evidence" });
    if (v.state !== "missing" && v.receipt_revision < 1)
      ctx.addIssue({ code: "custom", message: "Retained receipts have a positive revision" });
    if (v.state === "missing" && v.receipt_revision !== 0)
      ctx.addIssue({ code: "custom", message: "Missing receipts have revision zero" });
    if (v.state === "failed" && !v.error)
      ctx.addIssue({
        code: "custom",
        message: "Failed receipts include effect and stage evidence",
      });
  });
export type CommandReceipt = z.infer<typeof receiptSchema>;
export const cursorSchema = runtimeIdentity.extend({ source_key: wireId });
export const lossSchema = runtimeIdentity.extend({
  loss_id: wireId,
  report_revision: revision.refine((n) => n > 0),
  owner_id: wireId,
  termination: z.enum(["confirmed", "unknown"]),
  reason: wireId,
  observed_at: z.iso.datetime({ offset: true }),
});
export const requestSchema = runtimeIdentity
  .extend({
    owner_id: wireId,
    source_request_id: wireId,
    request_revision: revision.refine((n) => n > 0),
    native_request_id: z.union([wireId, z.number().int().safe()]),
    kind: z.enum(["permission", "elicitation"]),
    state: z.enum(["pending", "cancelled", "stale"]),
    payload: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.state === "pending" && !v.payload)
      ctx.addIssue({ code: "custom", message: "Pending private requests need their live payload" });
  });
export const gapPayloadSchema = z
  .object({
    reason: z.literal("native_output_dropped"),
    coverage: z.literal("partial"),
    native_range: z
      .object({
        from: wireId.nullable(),
        to: wireId.nullable(),
        count: z.number().int().safe().nonnegative().nullable(),
      })
      .strict(),
    time_range: z
      .object({
        from: z.iso.datetime({ offset: true }).nullable(),
        to: z.iso.datetime({ offset: true }).nullable(),
      })
      .strict(),
  })
  .strict();
export const machineScope = z.enum(["read", "send", "acp:control", "terminal:control"]);
export const machineScopes = z
  .array(machineScope)
  .min(1)
  .max(4)
  .refine((v) => new Set(v).size === v.length);
export type MachineScope = z.infer<typeof machineScope>;

// Protocol support is available by default; capability labels never grant authority.
// Each operation still needs enrollment consent, current policy and per-harness support.
const managedCoreCapabilities = [
  "managed-acp.v1",
  "command-receipts.v1",
  "session-stream.v1",
] as const;
export const managedCapabilities = [
  ...managedCoreCapabilities,
  "session-resume.v1",
  "session-force-resume.v1",
];
export const hasManagedProtocol = (capabilities: readonly string[]) =>
  managedCoreCapabilities.every((capability) => capabilities.includes(capability));

export const terminalCapabilities = [
  "terminal-launch.v1",
  "command-receipts.v1",
  "session-stream.v1",
] as const;
export const hasTerminalProtocol = (capabilities: readonly string[]) =>
  terminalCapabilities.every((capability) => capabilities.includes(capability));
export const hasSessionProtocol = (capabilities: readonly string[]) =>
  hasManagedProtocol(capabilities) || hasTerminalProtocol(capabilities);
export const executionScope = (protocol: string): MachineScope =>
  protocol === "terminal" ? "terminal:control" : "acp:control";
export const liveSourceKind = (protocol: string) =>
  protocol === "terminal" ? ("terminal_lifecycle" as const) : ("acp_stream" as const);
