import { expect, test } from "bun:test";
import { approvalTextParts, reviewableApproval } from "../shared/approval-content.ts";

const parts = (text: string) => [{ type: "text" as const, text }];
const hidden = [
  0x0000, 0x0008, 0x000b, 0x000c, 0x001b, 0x007f, 0x0085, 0x009b, 0x00ad, 0x061c, 0x200b, 0x200c,
  0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068,
  0x2069, 0xfeff,
];
test("approval text rejects controls, format characters and the entire Unicode tag block", () => {
  for (const point of [...hidden, ...Array.from({ length: 128 }, (_, i) => 0xe0000 + i)]) {
    const content = [
      ...parts("Visible instructions"),
      ...parts(`Hidden${String.fromCodePoint(point)}instruction`),
    ];
    expect(approvalTextParts.safeParse(content).success).toBe(false);
    expect(reviewableApproval("session_prompt", { content })).toBe(false);
  }
});
test("approval text preserves ordinary whitespace and visible Unicode without rewriting it", () => {
  for (const text of [
    "",
    "First\n\tsecond\r\nthird",
    "café — 中文 العربية 😀",
    "e\u0301",
    "Show \\u202E literally",
  ])
    expect(approvalTextParts.parse(parts(text))).toEqual(parts(text));
  expect(reviewableApproval("session_launch", {})).toBe(true);
});
