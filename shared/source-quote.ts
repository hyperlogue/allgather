// Source/diff quotes are compact excerpts; the locator keeps the full line range.
export const SOURCE_QUOTE_LINES = 4;
export const SOURCE_QUOTE_CHARACTERS = 2048;

export function sourceQuoteExcerpt(text: string): string {
  let quote = text
    .trim()
    .slice(0, SOURCE_QUOTE_CHARACTERS)
    .split("\n", SOURCE_QUOTE_LINES)
    .join("\n")
    .trimEnd();
  // Do not end an excerpt halfway through a UTF-16 surrogate pair.
  const last = quote.charCodeAt(quote.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) quote = quote.slice(0, -1);
  return quote;
}
