import { z } from "zod";

export const approvalTextParts = z
  .array(
    z
      .object({
        type: z.literal("text"),
        text: z
          .string()
          .refine(
            (value) =>
              !/(?![\t\n\r])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800]/u.test(
                value,
              ),
            "Hidden, private-use, unassigned, and surrogate characters are not allowed; tabs and line breaks are permitted",
          ),
      })
      .strict(),
  )
  .min(1)
  .max(100);

export function reviewableApproval(operation: string, input: Record<string, unknown>) {
  return operation !== "session_prompt" || approvalTextParts.safeParse(input.content).success;
}
