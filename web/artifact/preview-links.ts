export type PreviewLinkAction =
  | { kind: "artifact"; id: string; href: string }
  | { kind: "open"; href: string; confirm: boolean };

const artifactId = /^artifact_[\w-]{1,128}$/;

function artifactLink(url: URL): { id: string; href: string } | null {
  const workspace = /^\/artifact-workspace\/([^/]+)\/?$/.exec(url.pathname);
  if (workspace) {
    let id: string;
    try {
      id = decodeURIComponent(workspace[1]);
    } catch {
      return null;
    }
    if (!artifactId.test(id)) return null;
    return { id, href: `/artifact-workspace/${id}${url.search}${url.hash}` };
  }
  if (url.pathname !== "/" || url.searchParams.get("view") !== "artifacts") return null;
  const id = url.searchParams.get("artifact");
  if (!id || !artifactId.test(id)) return null;
  const version = url.searchParams.get("version");
  const search = version ? `?${new URLSearchParams({ version })}` : "";
  return { id, href: `/artifact-workspace/${id}${search}${url.hash}` };
}

export function previewLinkAction(
  href: unknown,
  newTab: unknown,
  appOrigin: string,
): PreviewLinkAction | null {
  if (typeof href !== "string" || href.length > 8192) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const sameOrigin = url.origin === appOrigin;
  if (newTab !== true && sameOrigin) {
    const artifact = artifactLink(url);
    if (artifact) return { kind: "artifact", ...artifact };
  }
  return { kind: "open", href: url.href, confirm: !sameOrigin };
}
