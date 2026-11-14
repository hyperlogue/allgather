export interface LiveEventHandlers {
  change: () => void;
  ready?: () => void;
  error?: () => void;
}

export function liveEvents(handlers: LiveEventHandlers, url = "/api/events"): () => void {
  let source: EventSource | undefined;
  const open = () => {
    if (source) return;
    source = new EventSource(url);
    source.addEventListener("ready", () => handlers.ready?.());
    source.addEventListener("change", () => handlers.change());
    source.onerror = () => handlers.error?.();
  };
  const close = () => {
    source?.close();
    source = undefined;
  };
  const restore = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) open();
  };
  addEventListener("pagehide", close);
  addEventListener("pageshow", restore);
  open();
  return () => {
    removeEventListener("pagehide", close);
    removeEventListener("pageshow", restore);
    close();
  };
}
