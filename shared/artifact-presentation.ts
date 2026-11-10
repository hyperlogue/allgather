// Artifact HTTP contracts, source/diff presentation, application bootstrap, and
// publisher-local wake targets.
export * from "./artifacts.ts";

export type DiffSide = "old" | "new";

// Maximum captured context rows a client requests at once. Larger gaps expand
// in successive requests; shared with the server's captured-patch validation.
export const MAX_CONTEXT_ROWS = 5000;

// ---- source/diff presentation ----

export type DiffLineType = "context" | "add" | "del" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  oldLine: number | null;
  newLine: number | null;
  // Pre-highlighted inner HTML for the line content (Shiki). For 'hunk' rows
  // this is the literal @@ header text (not highlighted).
  html: string;
  text: string; // raw text of the line (no leading +/-/space), for quote anchoring
  // Retained patch evidence: this side's final line had no newline terminator.
  noNewline?: true;
  // Hunk rows: held context for expand (`down` on the last hunk of each contiguous
  // run). Absent/zero = no expander.
  expandable?: { up: number; down: number };
}

export interface DiffFileChange {
  oldPath: string | null;
  newPath: string | null;
  path: string; // display path (newPath ?? oldPath)
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  lines: DiffLine[]; // flat list including hunk header rows
}

// One selected publication's highlighted patch, consumed by the diff renderer.
// ArtifactVersion owns its metadata; the renderer needs only identity and rows.
export interface PatchDiff {
  seq: number;
  files: DiffFileChange[];
}

// One entry in the syntax-theme picker (GET /api/themes): a curated light/dark
// family or a single bundled Shiki theme, grouped for the dropdown.
export interface ThemeOption {
  id: string;
  label: string;
  group: string;
}

// The current syntax theme's own editor colours (GET /api/theme-style): its
// background and default foreground, per light/dark slot. The client paints code
// surfaces with these (as --shiki-*-bg / --shiki-*) so a theme like Nord looks
// like it does in an editor instead of pale token colours on r3's neutral card.
// Blank strings ⇒ the client keeps its neutral fallback.
export interface ThemeStyle {
  lightBg: string;
  darkBg: string;
  lightFg: string;
  darkFg: string;
  // The theme's PALETTE STYLESHEET — where every rendered token span's colour
  // comes from. One rule per distinct foreground the theme can hand a token
  // (`html:not(.dark) .sl3{color:#…}` for the light slot, `html.dark .sd7{…}`
  // for the dark one) plus the font-style rules; the spans carry only the
  // matching class names. Spans used to carry both colours inline instead
  // (`style="--shiki-light:…;--shiki-dark:…"`), which measured 12x the source
  // size in blob JSON and gave every mounted span its own computed style. The
  // client injects this once as `<style data-r3-theme-css>`, replacing it when
  // the theme changes. Blank ⇒ no palette (unloadable theme): those lines fall
  // back to inline styles on a `.sx` span, so nothing renders colourless.
  css: string;
}

export interface RenderedFileLine {
  lineNo: number;
  // Shiki-highlighted inner HTML. Token spans carry palette classes
  // (`<span class="sl3 sd7">`), coloured by ThemeStyle.css for the SAME theme —
  // both are per-theme, so a client must not mix a line from one theme's render
  // with another theme's stylesheet.
  html: string;
  text: string; // raw line text for anchoring
}
