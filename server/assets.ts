import { watch } from "node:fs";
import type { HTMLBundle } from "bun";

interface Asset {
  body: Blob;
  type: string;
}
const builds = new WeakMap<HTMLBundle, Promise<{ assets: Map<string, Asset>; index: Asset }>>();
async function buildAssets(bundle: HTMLBundle) {
  const assets = new Map<string, Asset>();
  let index: Asset | undefined;
  if (bundle.files) {
    for (const file of bundle.files) {
      const asset = { body: Bun.file(file.path), type: file.headers["content-type"] };
      if (file.loader === "html" && file.isEntry) index = asset;
      else assets.set(`/${file.path.split("/").at(-1)}`, asset);
    }
  } else {
    const built = await Bun.build({
      entrypoints: [bundle.index],
      target: "browser",
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: bundle.index.endsWith("artifact.html")
        ? [(await import("bun-plugin-tailwind")).default]
        : [],
    });
    if (!built.success) throw new AggregateError(built.logs, "Browser build failed");
    for (const output of built.outputs) {
      const asset = { body: new Blob([await output.arrayBuffer()]), type: output.type };
      if (output.path.endsWith(".html")) index = asset;
      else assets.set(`/${output.path.split("/").at(-1)}`, asset);
    }
  }
  if (!index) throw new Error("Browser entrypoint is missing");
  let html = await index.body.text();
  for (const path of assets.keys()) {
    const filename = path.slice(1);
    for (const quote of ['"', "'"]) {
      html = html.replaceAll(`${quote}./${filename}${quote}`, `${quote}${path}${quote}`);
      html = html.replaceAll(`${quote}${filename}${quote}`, `${quote}${path}${quote}`);
    }
  }
  index = { ...index, body: new Blob([html]) };
  return { assets, index };
}
function buildFailure(error: unknown) {
  const logs = error instanceof AggregateError ? error.errors.map(String) : [];
  return new Response([String(error), ...logs].join("\n"), {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
function currentBuild(bundle: HTMLBundle) {
  let pending = builds.get(bundle);
  if (!pending) {
    const started = buildAssets(bundle);
    builds.set(bundle, started);
    started.catch(() => {
      if (builds.get(bundle) === started) builds.delete(bundle);
    });
    pending = started;
  }
  return pending;
}
export function watchAssets(directory: string, bundles: HTMLBundle[]) {
  const watcher = watch(directory, { recursive: true }, () => {
    for (const bundle of bundles) builds.delete(bundle);
  });
  return () => watcher.close();
}
export async function loadAssets(
  bundle: HTMLBundle,
  documentRoute: (path: string) => boolean = (path) =>
    ["/", "/sign-in", "/welcome"].includes(path) ||
    /^\/tower\/enroll\/enrollment-[a-zA-Z0-9]+$/.test(path),
) {
  await currentBuild(bundle);
  return async (request: Request) => {
    let built: Awaited<ReturnType<typeof buildAssets>>;
    try {
      built = await currentBuild(bundle);
    } catch (error) {
      return buildFailure(error);
    }
    const path = new URL(request.url).pathname;
    const asset = documentRoute(path) ? built.index : built.assets.get(path);
    if (!asset || !["GET", "HEAD"].includes(request.method))
      return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : asset.body, {
      headers: { "content-type": asset.type, "cache-control": "no-cache" },
    });
  };
}
