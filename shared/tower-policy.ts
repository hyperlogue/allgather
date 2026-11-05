import { z } from "zod";

const bytes = (value: string) => new TextEncoder().encode(value).length;
const identifier = z
  .string()
  .regex(
    /^[A-Za-z0-9_.-]{1,128}$/,
    "Use 1–128 ASCII letters, digits, underscores, dots, or hyphens",
  );
const selector = z
  .string()
  .min(1)
  .refine(
    (v) => bytes(v) <= 4096 && !/\p{Cc}/u.test(v) && !["harness:", "cwd:", "token:"].includes(v),
    "Use a nonempty selector of at most 4096 bytes without control characters",
  );
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const towerPolicyRule = z
  .object({
    id: identifier,
    from: selector,
    to: selector,
    action: z.enum(["allow", "ask", "deny"]),
    created_by: z.string(),
    created_at: integer,
  })
  .strict();
export const towerPolicy = z
  .array(towerPolicyRule)
  .max(1024)
  .superRefine((rules, ctx) => {
    const ids = new Set<string>();
    for (const [i, r] of rules.entries()) {
      if (ids.has(r.id))
        ctx.addIssue({
          code: "custom",
          path: [i, "id"],
          message: "Policy rule IDs must be unique",
        });
      ids.add(r.id);
    }
    if (bytes(JSON.stringify(rules)) > 1024 * 1024 - 1024)
      ctx.addIssue({
        code: "custom",
        message: "Policy must fit within the 1 MiB Tower frame limit",
      });
  });
export const towerPolicyAck = z.object({
  policy_id: z.literal("tower"),
  previous_revision: integer.nullable(),
  applied_revision: integer.nullable(),
  outcome: z.enum(["applied", "rejected"]),
  changed_rule_ids: z.array(identifier).max(2048),
  reason: z.string().max(300).nullable(),
  received_at: integer,
});
export type TowerPolicyRule = z.infer<typeof towerPolicyRule>;
export type TowerPolicyAck = z.infer<typeof towerPolicyAck>;
export interface TowerPolicyReport extends TowerPolicyAck {
  requested_revision: number;
  observed_at: string;
}
