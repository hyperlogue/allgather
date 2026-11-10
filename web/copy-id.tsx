import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { copyText } from "./artifact/clipboard.ts";

export function CopyId({ value, children }: { value: string; children?: ReactNode }) {
  const [tip, setTip] = useState<{ left: number; top: number; ok: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ok = await copyText(value);
    setTip({ left: rect.left + rect.width / 2, top: rect.top - 4, ok });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setTip(null), 1200);
  };
  return (
    <>
      <button
        type="button"
        className="copy-id"
        title={`Copy ${value}`}
        aria-label={`Copy ${value}`}
        onClick={copy}
      >
        <code>{children ?? value}</code>
      </button>
      {tip && (
        <span
          role="status"
          className={`copy-id-tip ${tip.ok ? "" : "failed"}`}
          style={{ left: tip.left, top: tip.top }}
        >
          {tip.ok ? "Copied" : "Could not copy"}
        </span>
      )}
    </>
  );
}
