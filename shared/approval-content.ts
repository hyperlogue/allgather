import { z } from "zod";

export const approvalTextParts = z
  .array(z.object({ type: z.literal("text"), text: z.string() }).strict())
  .min(1)
  .max(100);

export function reviewableApproval(operation: string, input: Record<string, unknown>) {
  return operation !== "session_prompt" || approvalTextParts.safeParse(input.content).success;
}
