import { ArtifactClient, artifactApiPath, threadApiPath } from "../../shared/artifact-client.ts";
import type {
  Artifact,
  ArtifactActor,
  ArtifactAnchorResolution,
  ArtifactBulkArchiveBody,
  ArtifactBulkArchiveResponse,
  ArtifactComment,
  ArtifactDetail,
  ArtifactFile,
  ArtifactLifecycleBody,
  ArtifactLifecycleResponse,
  ArtifactNotification,
  ArtifactPreviewContext,
  ArtifactPreviewNetwork,
  ArtifactSource,
  ArtifactTarget,
  ArtifactThread,
  ArtifactVersion,
  ArtifactWatcher,
  CreateArtifactCommentBody,
  EditArtifactBody,
  EditArtifactThreadBody,
} from "../../shared/artifacts.ts";
import { type AttachmentInput, attachmentPath } from "../../shared/attachments.ts";
import { applicationFetch } from "./application-fetch.ts";
import type { DiffFileChange, DiffLine } from "./types.ts";

export const HUMAN_ACTOR: ArtifactActor = { role: "human", sessionId: null };
const client = () =>
  new ArtifactClient({
    url: location.origin,
    fetch: applicationFetch,
  });
const versionPath = (id: string, seq: number) => `${artifactApiPath(id)}/versions/${seq}`;
const query = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) params.set(key, String(value));
  return `?${params}`;
};

// HTTP adapter for the artifact workspace.
export const artifactApi = {
  detail: (id: string) => client().json<ArtifactDetail>("GET", artifactApiPath(id)),
  anchorResolution: (id: string, seq: number, signal?: AbortSignal) =>
    client().json<ArtifactAnchorResolution>(
      "GET",
      `${threadApiPath(id)}/anchor-resolution?version=${seq}`,
      undefined,
      signal,
    ),
  versions: (id: string) =>
    client().json<ArtifactVersion[]>("GET", `${artifactApiPath(id)}/versions`),
  files: (id: string, seq: number) =>
    client().json<ArtifactFile[]>("GET", `${versionPath(id, seq)}/files`),
  source: (id: string, seq: number, path: string, theme?: string) =>
    client().json<ArtifactSource>("GET", `${versionPath(id, seq)}/source${query({ path, theme })}`),
  diff: (id: string, seq: number, theme?: string) =>
    client().json<DiffFileChange[]>("GET", `${versionPath(id, seq)}/diff${query({ theme })}`),
  context: (id: string, seq: number, path: string, start: number, end: number, theme?: string) =>
    client().json<{ path: string; lines: DiffLine[] }>(
      "GET",
      `${versionPath(id, seq)}/diff-context${query({ path, start, end, theme })}`,
    ),
  edit: (id: string, body: EditArtifactBody) =>
    client().json<Artifact>("PATCH", artifactApiPath(id), body),
  delete: (id: string) => client().json<{ ok: boolean }>("DELETE", artifactApiPath(id)),
  addThread: (
    id: string,
    body: string,
    target: ArtifactTarget,
    options: {
      attachments?: AttachmentInput[];
      operationKey?: string;
      mediaSnapshot?: AttachmentInput;
    } = {},
  ) =>
    client().json<ArtifactThread>("POST", `${artifactApiPath(id)}/threads`, {
      actor: HUMAN_ACTOR,
      body,
      target,
      ...options,
    }),
  editThread: (id: string, body: Omit<EditArtifactThreadBody, "actor">) =>
    client().json<ArtifactThread>("PATCH", threadApiPath(id), {
      ...body,
      actor: HUMAN_ACTOR,
    }),
  deleteThread: (id: string) =>
    client().json<{ ok: boolean }>("DELETE", threadApiPath(id), { actor: HUMAN_ACTOR }),
  comment: (id: string, body: Omit<CreateArtifactCommentBody, "actor">) =>
    client().json<ArtifactComment>("POST", `${threadApiPath(id)}/comments`, {
      ...body,
      actor: HUMAN_ACTOR,
    }),
  editComment: (id: string, body: string, attachments?: AttachmentInput[]) =>
    client().json<ArtifactComment>("PATCH", `/api/comments/${encodeURIComponent(id)}`, {
      actor: HUMAN_ACTOR,
      body,
      attachments,
    }),
  attachment: (artifactId: string, id: string) =>
    client().request("GET", attachmentPath(artifactId, id)),
  bulkArchive: (body: Omit<ArtifactBulkArchiveBody, "actor">) =>
    client().json<ArtifactBulkArchiveResponse>("POST", "/api/artifacts/archive", {
      ...body,
      actor: HUMAN_ACTOR,
    }),
  lifecycle: (id: string, body: Omit<ArtifactLifecycleBody, "actor">) =>
    client().json<ArtifactLifecycleResponse>("POST", `${artifactApiPath(id)}/lifecycle`, {
      ...body,
      actor: HUMAN_ACTOR,
    }),
  watchers: (id: string) =>
    client().json<ArtifactWatcher[]>("GET", `${artifactApiPath(id)}/watchers`),
  submit: (id: string) =>
    client().json<{ notification: ArtifactNotification }>("POST", `${artifactApiPath(id)}/submit`),
  viewed: (id: string) => client().json<string[]>("GET", `${artifactApiPath(id)}/viewed`),
  setViewed: (id: string, key: string, viewed: boolean) =>
    client().json("PUT", `${artifactApiPath(id)}/viewed`, { key, viewed }),
  download: (id: string, seq: number, path: string) =>
    client().request("GET", `${versionPath(id, seq)}/resource${query({ path })}`),
  // Native video requests carry the browser session cookie and can seek with
  // Range. Never put API credentials or preview capabilities in this URL.
  videoUrl: async (id: string, seq: number, path: string): Promise<string> =>
    `${versionPath(id, seq)}/resource${query({ path })}`,
  createPreview: (
    id: string,
    seq: number,
    path: string,
    network: ArtifactPreviewNetwork = "blocked",
  ) =>
    client().json<ArtifactPreviewContext>("POST", `${versionPath(id, seq)}/previews`, {
      path,
      network,
    }),
  renewPreview: (id: string) =>
    client().json<ArtifactPreviewContext>("PATCH", `/api/previews/${encodeURIComponent(id)}`),
  revokePreview: (id: string) => client().json("DELETE", `/api/previews/${encodeURIComponent(id)}`),
};
