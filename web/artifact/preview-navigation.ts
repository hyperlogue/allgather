import type { PreviewBootstrap } from "../../shared/preview-protocol.ts";
import type { PreviewConnection } from "./preview-channel.ts";

// Serialized into trusted support. File-stack links belong to the destination
// card; following one must not replace the source card's document or identity.
export function installPreviewNavigation(
  config: PreviewBootstrap,
  connection: PreviewConnection,
): void {
  let paths = new Set<string>();
  let lastNavigation: number | undefined;
  let frame = 0;
  connection.subscribe((message) => {
    if (message?.type !== "r3-preview-display" || message.contextId !== config.contextId) return;
    paths = new Set(message.display?.filePaths ?? []);
    const navigation = message.display?.navigation;
    if (!navigation || navigation.nonce === lastNavigation) return;
    lastNavigation = navigation.nonce;
    const destination = new URL(location.pathname + navigation.route, location.href);
    if (destination.search !== location.search) {
      // A query can select a different state of this same published document.
      // Keep the scroll handoff out of the browser's Back/Forward history.
      location.replace(location.pathname + navigation.route);
      return;
    }
    if (destination.hash !== location.hash) location.replace(location.pathname + navigation.route);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      let fragment: string;
      try {
        fragment = decodeURIComponent(destination.hash.slice(1));
      } catch {
        return;
      }
      const target = fragment
        ? (document.getElementById(fragment) ?? document.getElementsByName(fragment)[0])
        : document.body;
      target?.scrollIntoView({ block: fragment ? "center" : "start", inline: "nearest" });
    });
  });
  window.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      !paths.size
    )
      return;
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (
      !(target instanceof HTMLAnchorElement) ||
      target.hasAttribute("download") ||
      (target.target && target.target !== "_self")
    )
      return;
    let destination: URL;
    try {
      destination = new URL(target.href);
    } catch {
      return;
    }
    const root = new URL(config.resourceRoot);
    if (destination.origin !== root.origin || !destination.pathname.startsWith(root.pathname))
      return;
    let path: string;
    try {
      path = decodeURIComponent(destination.pathname.slice(root.pathname.length));
    } catch {
      return;
    }
    if (destination.pathname === location.pathname || !paths.has(path)) return;
    event.preventDefault();
    connection.send({
      type: "r3-preview-navigate",
      targetPath: path,
      route: destination.search + destination.hash || "#",
    });
  });
  window.addEventListener("pagehide", () => cancelAnimationFrame(frame));
}
