// Gutter line-number pick/drag. Instantiated per file block so the anchor
// never crosses files.

import { useCallback, useEffect, useRef, useState } from "react";
import { SOURCE_QUOTE_LINES, sourceQuoteExcerpt } from "../../shared/source-quote.ts";
import type { DiffSide } from "./types.ts";

export interface GutterPick {
  side: DiffSide;
  lineStart: number;
  lineEnd: number;
  quote: string;
}

interface Point {
  side: DiffSide;
  line: number;
}

// The live gutter selection, as a plain value the caller maps over its rows to
// derive a per-cell `selected` boolean — cheaper for memoized rows than calling
// a closure, since only rows whose boolean flips re-render during a drag.
export interface GutterSelection {
  side: DiffSide;
  lo: number;
  hi: number;
}

// The onDown/onEnter gutter handlers useGutterDrag returns, shared by the diff and
// file panes' gutter cells so the two panes' gutter contract can't silently drift.
export type GutterHandler = (side: DiffSide, line: number, e: React.MouseEvent) => void;
export type EnterHandler = (side: DiffSide, line: number) => void;

// The tint a gutter cell wears while inside the live drag selection — one class
// string for both panes.
export const GUTTER_SELECTED =
  "bg-primary-200 text-primary-900 dark:bg-primary-800 dark:text-primary-100";

// Whether line `n` on `side` falls inside the live gutter selection. Both panes
// derive each cell's `selected` boolean from this (a plain value, so memoized rows
// only re-render when their own flag flips). A null `n` (no line on this side) is
// never selected.
export function inSelection(
  sel: GutterSelection | null,
  side: DiffSide,
  n: number | null,
): boolean {
  return sel != null && sel.side === side && n != null && n >= sel.lo && n <= sel.hi;
}

// One window mouseup for every live gutter drag: first subscriber attaches, last
// detaches. Idle files register a handle but don't each own a listener. The
// handler reads `latest` from the drag that is actually `dragging`.
interface GutterDrag {
  dragging: { current: boolean };
  latest: {
    current: {
      anchor: Point | null;
      head: Point | null;
      textForLine: (side: DiffSide, line: number) => string | null;
      onPick: (pick: GutterPick) => void;
      finish: () => void;
    };
  };
}

const gutterDrags = new Set<GutterDrag>();

function onGutterMouseUp() {
  for (const d of gutterDrags) {
    if (!d.dragging.current) continue;
    d.dragging.current = false;
    const { anchor: a, head: h, textForLine: tf, onPick: pick, finish } = d.latest.current;
    if (!a) {
      finish();
      continue;
    }
    const end = h && h.side === a.side ? h.line : a.line;
    const lo = Math.min(a.line, end);
    const hi = Math.max(a.line, end);
    const parts: string[] = [];
    // Only collect enough source for the excerpt; keep the full picked range.
    for (let n = lo; n <= hi; n++) {
      const t = tf(a.side, n);
      if (t == null) break;
      if (!parts.length && !t.trim()) continue;
      parts.push(t);
      if (parts.length === SOURCE_QUOTE_LINES) break;
    }
    pick({ side: a.side, lineStart: lo, lineEnd: hi, quote: sourceQuoteExcerpt(parts.join("\n")) });
    finish();
  }
}

function retainGutterDrag(d: GutterDrag): () => void {
  gutterDrags.add(d);
  if (gutterDrags.size === 1) window.addEventListener("mouseup", onGutterMouseUp);
  return () => {
    gutterDrags.delete(d);
    if (gutterDrags.size === 0) window.removeEventListener("mouseup", onGutterMouseUp);
  };
}

export function useGutterDrag(opts: {
  // Raw text of the line numbered `line` on `side` (null if no such line).
  textForLine: (side: DiffSide, line: number) => string | null;
  onPick: (pick: GutterPick) => void;
}) {
  const { textForLine, onPick } = opts;
  const [anchor, setAnchor] = useState<Point | null>(null);
  const [head, setHead] = useState<Point | null>(null);
  const dragging = useRef(false);
  // Keep the latest values reachable from the window mouseup listener and from
  // the stable onDown/onEnter callbacks (which read the live anchor here).
  const latest = useRef({
    anchor,
    head,
    textForLine,
    onPick,
    finish: () => {
      setAnchor(null);
      setHead(null);
    },
  });
  latest.current.anchor = anchor;
  latest.current.head = head;
  latest.current.textForLine = textForLine;
  latest.current.onPick = onPick;

  const drag = useRef<GutterDrag>({ dragging, latest });
  useEffect(() => retainGutterDrag(drag.current), []);

  // Stable handlers: memoized rows keep the same handler identity across a drag,
  // so a re-render only re-reconciles rows whose `selected` flag actually flips.
  const onDown = useCallback((side: DiffSide, line: number, e: React.MouseEvent) => {
    e.preventDefault(); // don't start a text selection
    dragging.current = true;
    setAnchor({ side, line });
    setHead({ side, line });
  }, []);
  const onEnter = useCallback((side: DiffSide, line: number) => {
    const a = latest.current.anchor;
    if (dragging.current && a && side === a.side) setHead({ side, line });
  }, []);

  let selection: GutterSelection | null = null;
  if (anchor) {
    const end = head && head.side === anchor.side ? head.line : anchor.line;
    selection = {
      side: anchor.side,
      lo: Math.min(anchor.line, end),
      hi: Math.max(anchor.line, end),
    };
  }

  return { onDown, onEnter, selection };
}
