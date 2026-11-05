import { z } from "zod";
import { checkoutIdSchema } from "./tower-catalog.ts";
export const publicRecordFields = [
  "display_name",
  "node",
  "harness",
  "mode",
  "ownership",
  "protocol",
  "trust",
  "native_session_id",
  "pid",
  "cwd",
  "status",
  "status_detail",
  "caps",
  "labels",
  "task_refs",
  "last_seen",
  "revision",
] as const;
export const checkoutStatusFields = [...publicRecordFields, "checkout_id"] as const;
export const publicRecordFieldsFor = (capabilities: readonly string[]) =>
  capabilities.includes("checkout-sync.v1") ? checkoutStatusFields : publicRecordFields;
export const statusCheckoutIdSchema = checkoutIdSchema.nullable();
const id = z
  .string()
  .min(1)
  .max(160)
  .refine((s) => Buffer.byteLength(s) <= 160);
const seq = z.number().int().safe().nonnegative();
function deltaSchema(fields: typeof publicRecordFields | typeof checkoutStatusFields) {
  const field = z.enum(fields);
  return z
    .object({
      seq,
      base_seq: seq,
      upserts: z
        .array(
          z
            .object({
              id,
              set: z
                .record(z.string(), z.unknown())
                .refine((o) => Object.keys(o).every((k) => field.safeParse(k).success)),
              unset: z.array(field).max(fields.length),
            })
            .strict(),
        )
        .max(5000),
      removed: z.array(id).max(5000),
    })
    .strict()
    .superRefine((v, ctx) => {
      const ids = [...v.upserts.map((u) => u.id), ...v.removed];
      if (
        v.seq <= v.base_seq ||
        new Set(ids).size !== ids.length ||
        v.upserts.some(
          (u) =>
            new Set(u.unset).size !== u.unset.length ||
            u.unset.some((k) => Object.hasOwn(u.set, k)),
        ) ||
        v.upserts.some(
          (u) =>
            Object.hasOwn(u.set, "checkout_id") &&
            !statusCheckoutIdSchema.safeParse(u.set.checkout_id).success,
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Delta identity, fields, and sequence must be distinct",
        });
    });
}
export const stateDeltaSchema = deltaSchema(publicRecordFields);
const checkoutStateDeltaSchema = deltaSchema(checkoutStatusFields);
export const stateDeltaSchemaFor = (capabilities: readonly string[]) =>
  capabilities.includes("checkout-sync.v1") ? checkoutStateDeltaSchema : stateDeltaSchema;
