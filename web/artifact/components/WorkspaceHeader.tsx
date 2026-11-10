import type { ComponentPropsWithRef, ReactNode } from "react";
import logoUrl from "../../brand/logo-small.svg";
import { useTranslation } from "../i18n.ts";
import { Button, cn } from "../ui.tsx";

export function HeaderIconButton({ className, ...props }: ComponentPropsWithRef<"button">) {
  const expanded = props["aria-expanded"];
  return (
    <Button
      type="button"
      variant={expanded === true || expanded === "true" ? "primary-outline" : "nav"}
      className={cn(
        "h-[calc(1.75rem-2px)] w-7 shrink-0 justify-center p-0! max-md:size-9",
        className,
      )}
      {...props}
    />
  );
}

// Shared visual header; navigation and application-level tools belong to its host.
export function WorkspaceHeader({
  children,
  tools,
  homeHref = "/?view=artifacts",
  onHome,
}: {
  children?: ReactNode;
  tools?: ReactNode;
  homeHref?: string;
  onHome?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <header
      data-app-header
      className="relative z-40 flex min-h-[calc(2rem+4px)] shrink-0 items-center gap-2 border-b border-neutral-300 bg-white py-[2px] pl-3 max-md:gap-1 max-md:pl-2 dark:border-neutral-700 dark:bg-neutral-950"
    >
      <nav
        aria-label={t("workspaceHeader.mainNavigation")}
        className="flex shrink-0 items-center gap-1.5 self-stretch"
      >
        <a
          href={homeHref}
          target="_top"
          title={t("workspaceHeader.artifactLibrary")}
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              event.button !== 0
            )
              return;
            if (onHome) {
              event.preventDefault();
              onHome();
            }
          }}
          className="flex items-center self-stretch text-sm font-semibold text-neutral-800 hover:text-primary-600 max-md:min-h-9 dark:text-neutral-100 dark:hover:text-primary-400"
        >
          <img src={logoUrl} alt="" className="mr-2 size-5" />
          AllGather
        </a>
      </nav>
      {children ? (
        <>
          <span
            aria-hidden="true"
            className="mx-1.5 h-4 w-px shrink-0 bg-neutral-200 max-md:mx-0.5 dark:bg-neutral-800"
          />
          {children}
        </>
      ) : (
        <div className="flex-1" />
      )}
      <div className="flex shrink-0 items-center self-stretch">{tools}</div>
    </header>
  );
}
