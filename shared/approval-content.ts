import { z } from "zod";

export const approvalTextParts = z
  .array(
    z
      .object({
        type: z.literal("text"),
        text: z
          .string()
          .refine(
            (value) => !/[\p{Cc}\p{Cf}\u{E0000}-\u{E007F}]/u.test(value.replace(/[\t\n\r]/g, "")),
            "Control and format characters are not allowed; tabs and line breaks are permitted",
          ),
      })
      .strict(),
  )
  .min(1)
  .max(100);

export function reviewableApproval(operation: string, input: Record<string, unknown>) {
  return operation !== "session_prompt" || approvalTextParts.safeParse(input.content).success;
}
