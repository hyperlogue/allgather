export function parse(argv: string[]) {
  const positional: string[] = [],
    flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (
      [
        "force",
        "all",
        "no-ack",
        "no-listen",
        "clear-aliases",
        "clear-path-prefixes",
        "include-removed",
        "apply",
        "json",
        "remove",
        "help",
        "undefer",
        "clear-labels",
        "remove-icon",
        "needs-owner",
        "exclude-undated",
        "blocked",
        "pause",
        "resume",
        "is-done",
        "unassigned",
      ].includes(name)
    ) {
      if (inline !== undefined && inline !== "true" && inline !== "false")
        throw new Error(`--${name} expects true or false`);
      flags[name] = inline !== "false";
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    if (
      [
        "path",
        "path-prefix",
        "alias",
        "branch",
        "label",
        "labels-all",
        "labels-any",
        "add-label",
        "remove-label",
      ].includes(name)
    ) {
      const values = flags[name] as string[] | undefined;
      flags[name] = [...(values ?? []), value];
    } else flags[name] = value;
  }
  if (Array.isArray(flags.label) && positional[0] !== "task") {
    if (flags.label.length !== 1) throw new Error("--label is repeatable only for tasks");
    flags.label = flags.label[0];
  }
  return { positional, flags };
}
