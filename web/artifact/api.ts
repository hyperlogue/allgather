import { ArtifactClient } from "../../shared/artifact-client.ts";
import type { ThemeStyle } from "../../shared/artifact-presentation.ts";
import { applicationFetch } from "./application-fetch.ts";
import { artifactLocalStorage } from "./artifact-local-storage.ts";
import { draftImages } from "./attachment-drafts.ts";
import { markdownCache } from "./markdown-cache.ts";

// The artifact workspace uses Allgather's owner session. Preserve cache epochs
// across the request so a concurrent logout cannot reactivate private content.
export async function loadBoot(): Promise<{ needsAuth: boolean }> {
  const cacheEpoch = await markdownCache.authenticationEpoch();
  const storageEpoch = artifactLocalStorage.authenticationEpoch();
  const imageEpoch = await draftImages.epoch();
  const response = await applicationFetch("/api/boot");
  if (response.status === 401) {
    artifactLocalStorage.suspend();
    await markdownCache.suspend();
    await draftImages.clear();
    return { needsAuth: true };
  }
  if (!response.ok) throw new Error(`GET /api/boot → ${response.status}`);
  artifactLocalStorage.resume(storageEpoch);
  await markdownCache.resume(cacheEpoch);
  await draftImages.resume(imageEpoch);
  return { needsAuth: false };
}

export const api = {
  themeStyle: (theme?: string) =>
    new ArtifactClient({ url: location.origin, fetch: applicationFetch }).json<ThemeStyle>(
      "GET",
      `/api/theme-style${theme ? `?${new URLSearchParams({ theme })}` : ""}`,
    ),
};
