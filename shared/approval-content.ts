import { z } from "zod";

const escapedCharacters =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800]/gu;
const forbiddenCharacters = new RegExp(`(?![\\t\\n\\r])${escapedCharacters.source}`, "u");
export function visibleApprovalText(value: string) {
  return !forbiddenCharacters.test(value);
}
export function approvalDisplayText(value: string) {
  return value.replace(escapedCharacters, (char) =>
    visibleApprovalText(char)
      ? char
      : `\\u{${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`,
  );
}
function visibleStrings(value: unknown): boolean {
  const pending = [value],
    seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string" && !visibleApprovalText(current)) return false;
    if (current && typeof current === "object") {
      if (seen.has(current)) return false;
      seen.add(current);
      for (const [key, value] of Object.entries(current)) {
        if (!visibleApprovalText(key)) return false;
        pending.push(value);
      }
    }
  }
  return true;
}
export const approvalTextParts = z
  .array(
    z
      .object({
        type: z.literal("text"),
        text: z
          .string()
          .refine(
            visibleApprovalText,
            "Use visible, assigned Unicode text; tabs and line breaks are permitted",
          ),
      })
      .strict(),
  )
  .min(1)
  .max(100);
export function reviewableApproval(operation: string, input: unknown, context: unknown = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  return (
    (operation !== "session_prompt" ||
      approvalTextParts.safeParse((input as Record<string, unknown>).content).success) &&
    visibleStrings(input) &&
    visibleStrings(context)
  );
}
