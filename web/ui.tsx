import {
  type ButtonHTMLAttributes,
  Children,
  type InputHTMLAttributes,
  isValidElement,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { TaskState } from "../shared/contracts.ts";
import logoUrl from "./brand/logo-small.svg";
import { Icon, type IconName } from "./icons.tsx";
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
        <IconButton icon="close" label="Close dialog" onClick={close} />
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

type ButtonVariant = "default" | "primary" | "quiet" | "danger" | "link";
const buttonClass: Record<ButtonVariant, string> = {
  default: "",
  primary: "primary",
  quiet: "quiet",
  danger: "danger",
  link: "link-button",
};
export function Button({
  variant = "default",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const classes = [buttonClass[variant], className].filter(Boolean).join(" ");
  return <button type={type} className={classes || undefined} {...props} />;
}

export function IconButton({
  icon,
  label,
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { icon: IconName; label: string }) {
  return (
    <Button
      variant="quiet"
      className={["icon-button", className].filter(Boolean).join(" ")}
      aria-label={label}
      title={props.title ?? label}
      {...props}
    >
      <Icon name={icon} />
    </Button>
  );
}

export function Checkbox({
  label,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode }) {
  return (
    <label className={["checkbox", className].filter(Boolean).join(" ")}>
      <input type="checkbox" {...props} />
      {label}
    </label>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  change,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  change: (value: T) => void;
}) {
  return (
    <fieldset className="filters">
      <legend className="sr-only">{label}</legend>
      {options.map(([key, text]) => (
        <button type="button" key={key} aria-pressed={value === key} onClick={() => change(key)}>
          {text}
        </button>
      ))}
    </fieldset>
  );
}

export function Chip({
  tone = "label",
  children,
}: {
  tone?: "label" | "agent" | "action" | "warning";
  children: ReactNode;
}) {
  return (
    <span className={tone === "label" ? "label-chip" : `status-chip ${tone}`}>{children}</span>
  );
}

export function StateDot({ state }: { state: TaskState }) {
  return <span className={`state-dot ${state}`} aria-hidden="true" />;
}

export function Banner({
  tone = "warning",
  strip = false,
  action,
  children,
}: {
  tone?: "warning" | "danger";
  strip?: boolean;
  action?: { label: string; run: () => void };
  children: ReactNode;
}) {
  if (strip)
    return (
      <div className={`banner-strip ${tone}`} role="status">
        <span>{children}</span>
        {action && <Button onClick={action.run}>{action.label}</Button>}
      </div>
    );
  return tone === "danger" ? (
    <p className="error" role="alert">
      {children}
    </p>
  ) : (
    <p className="notice">{children}</p>
  );
}

export function EmptyState({
  title,
  children,
  as: Tag = "div",
}: {
  title?: string;
  children: ReactNode;
  as?: "div" | "section";
}) {
  if (!title) return <p className="empty-copy">{children}</p>;
  return (
    <Tag className="empty">
      <h2>{title}</h2>
      <p>{children}</p>
    </Tag>
  );
}

export function usePopover(
  open: boolean,
  setOpen: (open: boolean) => void,
  root: RefObject<HTMLElement | null>,
  { items, initial, trigger }: { items: string; initial: string; trigger: string },
) {
  useEffect(() => {
    if (!open) return;
    (
      root.current?.querySelector<HTMLElement>(initial) ??
      root.current?.querySelector<HTMLElement>(items)
    )?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        root.current?.querySelector<HTMLElement>(trigger)?.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const options = [...(root.current?.querySelectorAll<HTMLElement>(items) ?? [])];
        const index = options.indexOf(document.activeElement as HTMLElement);
        options[
          (index + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
        ]?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, setOpen, root, items, initial, trigger]);
}

type SelectOption = { value: string; label: ReactNode; disabled: boolean };
function selectOptions(children: ReactNode): SelectOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ value?: string; children?: ReactNode; disabled?: boolean }>(child))
      return [];
    if (child.type !== "option") return [];
    return [
      {
        value: String(child.props.value ?? ""),
        label: child.props.children,
        disabled: !!child.props.disabled,
      },
    ];
  });
}
export function Select({
  children,
  className,
  id,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "onClick">) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const native = useRef<HTMLSelectElement>(null);
  const options = selectOptions(children);
  const value = String(props.value ?? "");
  const current = options.find((option) => option.value === value);
  usePopover(open, setOpen, root, {
    items: ".select-option:not(:disabled)",
    initial: '.select-option[aria-selected="true"]',
    trigger: ".select-trigger",
  });
  const choose = (next: string) => {
    const element = native.current;
    setOpen(false);
    root.current?.querySelector<HTMLElement>(".select-trigger")?.focus();
    if (!element || next === value) return;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(element, next);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  return (
    <div className={["select", className].filter(Boolean).join(" ")} ref={root}>
      <select {...props} ref={native} className="select-native" tabIndex={-1} aria-hidden="true">
        {children}
      </select>
      <button
        type="button"
        id={id}
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={props["aria-label"]}
        disabled={props.disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={current?.value ? undefined : "select-placeholder"}>
          {current?.label ?? ""}
        </span>
        <Icon name="chevron" />
      </button>
      {open && (
        <div className="select-menu" role="listbox" aria-label={props["aria-label"]}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              key={option.value}
              className="select-option"
              aria-selected={option.value === value}
              disabled={option.disabled}
              onClick={() => choose(option.value)}
            >
              <span>{option.label}</span>
              {option.value === value && <Icon name="check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
