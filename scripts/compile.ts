import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { artifactCssPlugin } from "./artifact-css.ts";

const root = join(import.meta.dir, "..");
mkdirSync(join(root, "dist"), { recursive: true });
for (const server of [false, true]) {
  const name = server ? "allgather-server" : "allgather";
  const result = await Bun.build({
    entrypoints: server
      ? [join(root, "server/cli.ts"), join(root, "server/highlight-worker.ts")]
      : [join(root, "cli/index.ts")],
    plugins: server ? [await artifactCssPlugin()] : [],
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    compile: { outfile: join(root, "dist", name) },
  });
  if (!result.success) throw new AggregateError(result.logs, `${name} build failed`);
}
console.log("Built dist/allgather (HTTP client) and dist/allgather-server (server and browser)");
