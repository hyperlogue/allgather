import { QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactDetail } from "../server/r3/shared/artifacts.ts";
import { api, loadBoot } from "../server/r3/web/src/api.ts";
import { artifactApi } from "../server/r3/web/src/artifact-api.ts";
import { ArtifactPage } from "../server/r3/web/src/artifact-page.tsx";
import { ArtifactPreview } from "../server/r3/web/src/components/ArtifactPreview.tsx";
import { WorkspaceHeader } from "../server/r3/web/src/components/WorkspaceHeader.tsx";
import { useDarkTheme } from "../server/r3/web/src/hooks.ts";
import type { ArtifactDelivery } from "../shared/artifact-delivery.ts";

const data = { ...artifactApi, themeStyle: api.themeStyle };
function Workspace() {
  const [detail, setDetail] = useState<
      (ArtifactDetail & { delivery?: ArtifactDelivery | null }) | null
    >(null),
    [error, setError] = useState(""),
    [auth, setAuth] = useState(false),
    [queryClient] = useState(
      () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
  useDarkTheme();
  const id = decodeURIComponent(location.pathname.split("/").at(-1) ?? "");
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined,
      events: EventSource | undefined;
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["artifact-watchers", id] });
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          void artifactApi
            .detail(id)
            .then((d) => {
              if (active) {
                setDetail(d);
                setError("");
              }
            })
            .catch((e) => active && setError(e.message)),
        100,
      );
    };
    void loadBoot()
      .then(async (boot) => {
        if (!active) return;
        if (boot.needsAuth) {
          setAuth(true);
          return;
        }
        const detail = await artifactApi.detail(id);
        if (!active) return;
        setDetail(detail);
        events = new EventSource("/api/events");
        events.addEventListener("change", refresh);
        events.addEventListener("ready", refresh);
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
      clearTimeout(timer);
      events?.close();
    };
  }, [id, queryClient]);
  if (auth)
    return (
      <p className="artifact-boot">
        <a href="/" target="_top">
          Sign in to Allgather
        </a>{" "}
        to open this artifact.
      </p>
    );
  if (error)
    return (
      <p className="artifact-boot" role="alert">
        {error}
      </p>
    );
  if (!detail) return <p className="artifact-boot">Opening artifact…</p>;
  return (
    <ArtifactPage
      detail={detail}
      data={data}
      actions={artifactApi}
      renderPreview={(props) => <ArtifactPreview {...props} />}
      persistLocation
      queryClient={queryClient}
      chrome={{
        header: (children) => (
          <>
            <WorkspaceHeader>{children}</WorkspaceHeader>
            {detail.delivery && (
              <details className="artifact-delivery">
                <summary>
                  {detail.delivery.event === "archived"
                    ? "Archive notification"
                    : "Last review notification"}{" "}
                  ·{" "}
                  {detail.delivery.acknowledgement === "adapter"
                    ? "Adapter accepted"
                    : (detail.delivery.acknowledgement ?? detail.delivery.state)}
                </summary>
                <p>{detail.delivery.message}</p>
              </details>
            )}
          </>
        ),
        onDeleted: () => {
          if (parent !== window)
            parent.postMessage({ type: "allgather-artifact-deleted", id }, location.origin);
          else location.assign("/?view=artifacts");
        },
      }}
    />
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Workspace />);
