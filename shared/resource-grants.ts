import { z } from "zod";

const selection = z.union([z.literal("*"), z.array(z.string().min(1).max(300)).max(5000)]);
export const resourceGrantsSchema = z
  .object({
    project_ids: selection.default([]),
    machine_ids: selection.default([]),
    unassigned: z.boolean().default(false),
  })
  .strict();
export type ResourceGrants = z.infer<typeof resourceGrantsSchema>;
export const noResources: ResourceGrants = { project_ids: [], machine_ids: [], unassigned: false };
