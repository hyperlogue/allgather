import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";

type Position = { x: number; y: number };
type Anchor = { left: number; top: number; bottom: number };
const inset = 16;

// Keep geometry local to the floating shell. Typing never measures layout, and
// moving a note never changes its native target or subscribes the workspace.
export function useFloatingComposer(anchor?: Anchor) {
  const ref = useRef<HTMLDivElement>(null);
  const position = useRef<Position | null>(null);
  const size = useRef({ width: 0, height: 0 });
  const cleanup = useRef<(() => void) | null>(null);
  const { left, top, bottom } = anchor ?? {};
  const place = useCallback((value: Position) => {
    const next = {
      x: Math.max(inset, Math.min(window.innerWidth - size.current.width - inset, value.x)),
      y: Math.max(inset, Math.min(window.innerHeight - size.current.height - inset, value.y)),
    };
    if (ref.current) {
      ref.current.style.left = `${next.x}px`;
      ref.current.style.top = `${next.y}px`;
    }
    return next;
  }, []);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || left === undefined || top === undefined || bottom === undefined) {
      position.current = null;
      return;
    }
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      size.current = { width, height };
      const next = place(
        position.current ?? {
          x: left - width / 2,
          y: bottom > window.innerHeight / 2 ? top - height - 8 : bottom + 8,
        },
      );
      if (position.current) position.current = next;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      cleanup.current?.();
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [left, top, bottom, place]);

  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!anchor || event.button !== 0 || !event.isPrimary || !ref.current) return;
    cleanup.current?.();
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointer = event.pointerId;
    const origin = ref.current.getBoundingClientRect();
    const { clientX, clientY } = event;
    const { cursor, userSelect } = document.body.style;
    try {
      handle.setPointerCapture(pointer);
    } catch {
      // The pointer may already be cancelled.
      return;
    }
    handle.style.cursor = "grabbing";
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      position.current = place({
        x: origin.x + next.clientX - clientX,
        y: origin.y + next.clientY - clientY,
      });
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId === pointer) cleanup.current?.();
    };
    cleanup.current = () => {
      cleanup.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      handle.style.cursor = "";
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
  };
  return { ref, start };
}
