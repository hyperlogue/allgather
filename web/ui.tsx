import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import logoUrl from "./brand/logo-small.svg";
export function Brand() {
  return (
    <span className="brand">
      <img alt="" className="brand-mark" src={logoUrl} />
      <span className="brand-name">AllGather</span>
    </span>
  );
}
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef(false);
  const run = useCallback(async (fn: () => Promise<void>) => {
    if (active.current) return false;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      active.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}
export function ErrorText({ children }: { children: string }) {
  return children ? (
    <p className="error" role="alert">
      {children}
    </p>
  ) : null;
}
export function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    ref.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);
  return (
    <dialog ref={ref} onCancel={close}>
      <div className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="quiet" onClick={close} aria-label="Close dialog">
          ✕
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function FeaturePlaceholder({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="feature-placeholder">
      <h3>
        {title}
        <small>Not available yet</small>
      </h3>
      <p>{children}</p>
    </section>
  );
}

export function PageHeading({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setHost(document.getElementById("view-heading")), []);
  const heading = <div className="page-heading">{children}</div>;
  return host ? createPortal(heading, host) : heading;
}

export function LoginFrame({ children }: { children: ReactNode }) {
  return (
    <main className="login">
      <div className="login-card">{children}</div>
    </main>
  );
}
