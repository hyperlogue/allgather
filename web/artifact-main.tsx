import "./theme.ts";
import { QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactDelivery } from "../shared/artifact-delivery.ts";
import type { ArtifactDetail } from "../shared/artifacts.ts";
import { api, loadBoot } from "./artifact/api.ts";
import { artifactApi } from "./artifact/artifact-api.ts";
import { ArtifactPage } from "./artifact/artifact-page.tsx";
import { ArtifactPreview } from "./artifact/components/ArtifactPreview.tsx";
import { WorkspaceHeader } from "./artifact/components/WorkspaceHeader.tsx";
import { liveEvents } from "./live-events.ts";
import { useDarkTheme } from "./theme.ts";

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
      stopEvents: (() => void) | undefined;
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
        stopEvents = liveEvents({ change: refresh, ready: refresh });
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
      clearTimeout(timer);
      stopEvents?.();
    };
  }, [id, queryClient]);
  if (auth)
    return (
      <p className="artifact-boot">
        <a href="/" target="_top">
          Sign in to AllGather
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
        onOpenArtifact: (target, href) => {
          if (parent !== window)
            parent.postMessage(
              {
                type: "allgather-artifact-open",
                id: target,
                version: new URL(href, location.origin).searchParams.get("version"),
              },
              location.origin,
            );
          else location.assign(href);
        },
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
