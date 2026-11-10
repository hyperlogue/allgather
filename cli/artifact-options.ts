export type ArtifactFlags = Record<string, string | boolean | string[]>;
const capture =
  "root path ref patch commit base head input label version-label summary expected-seq no-listen";
const target = "target file version view line quote selector route side";
const message = "body body-file input attach";
const commands: Record<string, string> = {
  create: `kind title project task remote meta ${capture}`,
  publish: `${capture} task`,
  list: "state kind project meta mine cursor limit",
  search: "state kind project attention type history all cursor limit",
  show: "",
  versions: "",
  files: "version",
  source: "version path start limit",
  download: "version path output",
  patch: "version output",
  image: "image output",
  comments: "all no-ack attachments-dir threads",
  watch: "timeout attachments-dir",
  prompt: "",
  "thread-source": "",
  "comment-show": "",
  "thread-add": `${message} ${target} frame`,
  comment: `${message} ${target} frame expected-seq expected-anchor`,
  "thread-edit": `${message} status clear-attachments`,
  "comment-edit": `${message} clear-attachments`,
  "thread-delete": "",
  claim: "",
  release: "",
  reanchor: `${target} input artifact frame expected-anchor`,
  edit: "title input meta",
  archive: "body body-file",
  restore: "",
  delete: "",
  listen: "mode",
  unlisten: "",
  submit: "",
  watchers: "",
  stat: "window",
  gc: "input apply ttl",
  guide: "",
};
export function validateArtifactOptions(verb: string, p: string[], f: ArtifactFlags) {
  if (!(verb in commands))
    throw new Error("Unknown artifact command. Run allgather artifact guide.");
  const allowed = new Set(
    `${commands[verb]} json key url operator-name operator-kind agent-type session`.split(" "),
  );
  for (const flag of Object.keys(f))
    if (!allowed.has(flag)) throw new Error(`Unsupported --${flag} for artifact ${verb}`);
  if (verb === "guide" && p.length > 3) throw new Error("Use artifact guide [files|html|diff]");
  if (verb === "reanchor" && (p.length > 3 || (f.artifact !== undefined && p.length !== 2)))
    throw new Error("Choose a positional ID or --artifact");
  if (["source", "download"].includes(verb) && (!Array.isArray(f.path) || f.path.length !== 1))
    throw new Error("Supply exactly one --path");
  if (verb === "image" && !f.image) throw new Error("Supply --image ID");
  if (verb === "search" && f.all !== undefined && f.history !== undefined)
    throw new Error("Use --all or --history, not both");
  const noId = ["create", "list", "stat", "gc"];
  if (
    noId.includes(verb)
      ? p.length !== 2
      : !["claim", "release", "guide", "reanchor"].includes(verb) && p.length !== 3
  )
    throw new Error(`Invalid arguments for artifact ${verb}`);
  if (["claim", "release"].includes(verb) && p.length < 3) throw new Error("Supply thread IDs");
  for (const flag of ["version", "start", "limit", "expected-seq", "expected-anchor", "cursor"]) {
    if (f[flag] === undefined) continue;
    const n = Number(f[flag]);
    if (
      !Number.isSafeInteger(n) ||
      n < (["expected-seq", "expected-anchor", "cursor"].includes(flag) ? 0 : 1)
    )
      throw new Error(`Invalid --${flag}`);
  }
  for (const pair of [
    ["label", "version-label"],
    ["body", "body-file"],
    ["attach", "clear-attachments"],
  ])
    if (pair.every((k) => f[k] !== undefined))
      throw new Error(`Do not combine --${pair[0]} and --${pair[1]}`);
}
export function metadata(f: ArtifactFlags) {
  const entries = (f.meta as string[] | undefined) ?? [];
  return Object.fromEntries(
    entries.map((entry) => {
      const at = entry.indexOf("=");
      if (at < 1) throw new Error("--meta requires key=value");
      return [entry.slice(0, at), entry.slice(at + 1)];
    }),
  );
}
export function artifactTarget(
  f: ArtifactFlags,
  destination = false,
): Record<string, unknown> | undefined {
  const coordinates = ["file", "version", "view", "line", "quote", "selector", "route", "side"];
  if (f.target !== undefined) {
    if (coordinates.some((k) => f[k] !== undefined))
      throw new Error("Use --target JSON or coordinate flags, not both");
    const value = JSON.parse(String(f.target));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("--target must be an object");
    return value;
  }
  if (!coordinates.some((k) => f[k] !== undefined)) return undefined;
  if (!f.file || !f.version || !["source", "rendered", "diff"].includes(String(f.view)))
    throw new Error("A target needs --file, --version, and --view source|rendered|diff");
  if (destination && f.quote !== undefined)
    throw new Error("Reanchor destinations cannot change original quotes");
  const base = { kind: f.view, path: f.file, versionSeq: Number(f.version) };
  if (f.view === "rendered") {
    if (f.line || f.side) throw new Error("Rendered targets use selectors");
    if (!f.selector && (f.quote || f.route))
      throw new Error("--quote and --route require --selector");
    return {
      ...base,
      locator: f.selector
        ? {
            selector: f.selector,
            ...(f.quote ? { quote: f.quote } : {}),
            ...(f.route ? { route: f.route } : {}),
          }
        : null,
    };
  }
  if (f.selector || f.route || (f.view === "source" && f.side))
    throw new Error("Incompatible source/diff target flags");
  if (!f.line) {
    if (f.quote || f.side) throw new Error("--quote and --side require --line");
    return { ...base, locator: null };
  }
  const range = /^(\d+)(?:-(\d+))?$/.exec(String(f.line));
  const start = Number(range?.[1]),
    end = Number(range?.[2] ?? range?.[1]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
    throw new Error("--line requires a positive line or start-end range");
  if (!destination && !f.quote) throw new Error("Source/diff line targets require --quote");
  const side = f.side ?? "new";
  if (!["old", "new"].includes(String(side))) throw new Error("--side must be old or new");
  return {
    ...base,
    locator: {
      start,
      end,
      ...(!destination ? { quote: f.quote } : {}),
      ...(f.view === "diff" ? { side } : {}),
    },
  };
}
