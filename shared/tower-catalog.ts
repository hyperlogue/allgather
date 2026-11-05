import { z } from "zod";

export const catalogCapabilities = [
  "repository-catalog.v1",
  "repository-catalog-delta.v1",
  "checkout-sync.v1",
] as const;
export const checkoutIdSchema = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (v) =>
      Buffer.byteLength(v) <= 160 &&
      [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
  );
const id = checkoutIdSchema;
const uint = z.number().int().safe().nonnegative();
const revision = uint.min(1);
const label = z.string().min(1).max(300);
const nullableText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !v.includes("\0"))
    .nullable();
export const catalogProjectSchema = z.object({ id, name: label }).strict();
const remote = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (/[\s?#]/.test(value)) return false;
    if (/^[^/@:]+@[^/:]+:[^\s]+$/.test(value)) return true;
    try {
      const url = new URL(value);
      return (
        ["ssh:", "https:"].includes(url.protocol) &&
        !url.password &&
        !(url.protocol === "https:" && url.username) &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Catalog URLs must be credential-free SSH or HTTPS remotes");
export const catalogRepositorySchema = z
  .object({
    id,
    name: label,
    project_ids: z.array(id).max(5000),
    upstream_url: remote.nullable(),
    url_aliases: z.array(remote).max(100),
  })
  .strict();
export const catalogSchema = z
  .object({
    revision,
    projects: z.array(catalogProjectSchema).max(5000),
    repositories: z.array(catalogRepositorySchema).max(5000),
  })
  .strict()
  .superRefine((v, ctx) => {
    const projects = new Set(v.projects.map((p) => p.id));
    if (
      projects.size !== v.projects.length ||
      new Set(v.repositories.map((r) => r.id)).size !== v.repositories.length ||
      v.repositories.some(
        (r) =>
          new Set(r.project_ids).size !== r.project_ids.length ||
          r.project_ids.some((p) => !projects.has(p)),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Catalog identities and project references must be valid and distinct",
      });
  });
export const catalogAckSchema = z.object({ revision }).strict();
export const resyncSchema = z.object({}).strict();
const changes = <T extends z.ZodType<{ id: string }>>(record: T) =>
  z
    .object({ upserts: z.array(record).max(5000), removed: z.array(id).max(5000) })
    .strict()
    .superRefine((v, ctx) => {
      const ids = [...v.upserts.map((r) => r.id), ...v.removed];
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: "custom", message: "Delta IDs must be distinct" });
    });
export const catalogDeltaSchema = z
  .object({
    base_revision: revision,
    revision,
    projects: changes(catalogProjectSchema),
    repositories: changes(catalogRepositorySchema),
  })
  .strict()
  .refine((v) => v.revision > v.base_revision, "Catalog revision must advance");

export const checkoutSchema = z
  .object({
    id,
    repository_id: id.nullable(),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => !v.includes("\0")),
    system: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/),
    branch: nullableText(1024),
    head: nullableText(128),
    dirty: z.boolean(),
    conflicts: z.boolean(),
    locked: z.boolean(),
    prunable: z.boolean(),
    available: z.boolean(),
    tracking_ref: nullableText(1024),
    ahead: uint.nullable(),
    behind: uint.nullable(),
    observed_at: uint.max(8_640_000_000_000_000),
    revision,
  })
  .strict();
export const checkoutSnapshotSchema = z
  .object({ seq: uint, full: z.literal(true), records: z.array(checkoutSchema).max(5000) })
  .strict()
  .refine(
    (v) => new Set(v.records.map((r) => r.id)).size === v.records.length,
    "Checkout IDs must be distinct",
  );
export const checkoutDeltaSchema = z
  .object({ seq: uint, base_seq: uint, ...changes(checkoutSchema).shape })
  .strict()
  .superRefine((v, ctx) => {
    const ids = [...v.upserts.map((r) => r.id), ...v.removed];
    if (v.seq <= v.base_seq || new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        message: "Checkout delta IDs must be distinct and sequence must advance",
      });
  });
export type RepositoryCatalog = z.infer<typeof catalogSchema>;
export type TowerCheckout = z.infer<typeof checkoutSchema>;
export interface CheckoutObservation
  extends Omit<
    TowerCheckout,
    | "id"
    | "system"
    | "dirty"
    | "conflicts"
    | "locked"
    | "prunable"
    | "available"
    | "observed_at"
    | "revision"
  > {
  machine_id: string;
  checkout_id: string | null;
  identity: "tower" | "legacy_path";
  system: string | null;
  dirty: boolean | null;
  conflicts: boolean | null;
  locked: boolean | null;
  prunable: boolean | null;
  available: boolean | null;
  observed_at: number | null;
  revision: number | null;
  received_at: string | null;
  present: boolean;
  connected: boolean;
}
export interface CatalogSyncStatus {
  catalog_revision: number;
  catalog_error: string | null;
  checkout_error: string | null;
  checkout_received_at: string | null;
  checkouts_current: number;
}
