import { z } from "zod";

const argument = z
  .string()
  .max(8192)
  .refine((value) => !value.includes("\0"), "NUL is not allowed");
export const gatewayListSchema = z
  .array(
    z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
        command: z
          .array(argument)
          .min(1)
          .max(64)
          .refine((command) => command[0]?.trim().length, "Supply an executable"),
        cwd: argument.refine((value) => value.length > 0).optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
  )
  .max(8)
  .refine(
    (rows) => new Set(rows.map((row) => row.name)).size === rows.length,
    "Gateway names must be unique",
  );
export type GatewayConfig = z.infer<typeof gatewayListSchema>[number];
