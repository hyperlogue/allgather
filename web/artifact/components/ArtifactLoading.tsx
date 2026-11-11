import { LoadingMark } from "../../loading-indicator.tsx";
import { useTranslation } from "../i18n.ts";
import { cn } from "../ui.tsx";

export function ArtifactLoading({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t("common.loading")}
      className={cn(
        "flex min-h-80 flex-1 flex-col items-center justify-center gap-4 bg-white p-6 text-xs text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400",
        className,
      )}
    >
      <LoadingMark />
      <span>{t("common.loading")}</span>
    </div>
  );
}
