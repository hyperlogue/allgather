import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";
// Lower Tailwind/nesting in a separate browser pass before the Bun executable build.
export async function artifactCssPlugin(): Promise<Bun.BunPlugin> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../web/artifact/main.css")],
    target: "browser",
    plugins: [tailwind],
    minify: true,
  });
  if (!build.success || !build.outputs[0])
    throw new AggregateError(build.logs, "Artifact stylesheet build failed");
  const css = await build.outputs[0].text();
  return {
    name: "artifact-css",
    setup(builder) {
      builder.onLoad({ filter: /web[\\/]artifact[\\/]main\.css$/ }, () => ({
        contents: css,
        loader: "css",
      }));
    },
  };
}
