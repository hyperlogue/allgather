import { imagePlaceholder } from "../../shared/attachments.ts";

export interface ImageInsertion {
  start: number;
  end: number;
  text?: string;
}

export function insertImagePlaceholders(
  body: string,
  first: number,
  count: number,
  insertion: ImageInsertion = { start: body.length, end: body.length },
): { body: string; caret: number } {
  const start = Math.max(0, Math.min(body.length, insertion.start));
  const end = Math.max(start, Math.min(body.length, insertion.end));
  const before = body.slice(0, start) + (insertion.text ?? "");
  const after = body.slice(end);
  const labels = Array.from({ length: count }, (_, index) => imagePlaceholder(first + index)).join(
    " ",
  );
  const prefix = before.endsWith(" ") ? "" : " ";
  const suffix = after.startsWith(" ") ? "" : " ";
  return {
    body: before + prefix + labels + suffix + after,
    // When the following text already starts with a space, resume after it.
    caret: before.length + prefix.length + labels.length + 1,
  };
}

// Attachment positions define message-local labels. Replacing image bytes keeps
// the label; deleting an image removes its references and renumbers later ones.
export function imageMessageBody<Id extends string | number>(
  body: string,
  before: readonly { id: Id }[],
  after: readonly { id: Id }[],
  insertion?: ImageInsertion,
): string {
  if (after.length > before.length)
    return insertImagePlaceholders(body, before.length + 1, after.length - before.length, insertion)
      .body;
  if (after.length >= before.length) return body;
  return body.replace(/\[image([1-9]\d*)\]/g, (label, number: string) => {
    const original = before[Number(number) - 1];
    if (!original) return label;
    const index = after.findIndex((item) => item.id === original.id);
    return index < 0 ? "" : imagePlaceholder(index + 1);
  });
}
