import { artifactLocalStorage } from "./artifact-local-storage.ts";
// All artifact requests use the owner's same-origin session. Never follow an
// application redirect or reuse an authenticated response from the HTTP cache.
export async function applicationFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, { ...init, redirect: "error", cache: "no-cache" });
  if (response.status === 401 || response.status === 403) artifactLocalStorage.suspend();
  const path = new URL(input instanceof Request ? input.url : String(input), location.origin)
    .pathname;
  const artifact = /^\/api\/artifacts\/([^/]+)$/.exec(path)?.[1];
  if (artifact && (response.status === 404 || response.status === 410))
    artifactLocalStorage.forget(decodeURIComponent(artifact));
  return response;
}
