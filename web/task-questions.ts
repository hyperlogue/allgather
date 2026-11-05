import { z } from "zod";

const questions = z
  .array(
    z
      .object({
        question: z.string().trim().min(1).max(2000),
        options: z
          .array(z.string().trim().min(1).max(2000))
          .min(1)
          .max(8)
          .refine((a) => new Set(a).size === a.length),
      })
      .strict(),
  )
  .min(1)
  .max(20)
  .refine((a) => new Set(a.map((q) => q.question)).size === a.length);
export function taskQuestions(body: string) {
  const blocks = [...body.matchAll(/^```questions\s*\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1) return null;
  try {
    const result = questions.safeParse(JSON.parse(blocks[0][1]));
    return result.success
      ? { questions: result.data, description: body.replace(blocks[0][0], "").trim() }
      : null;
  } catch {
    return null;
  }
}
export function taskAnswer(questions: { question: string }[], answers: string[]) {
  return questions.map((q, i) => `${q.question}\n\n${answers[i]}`).join("\n\n---\n\n");
}
