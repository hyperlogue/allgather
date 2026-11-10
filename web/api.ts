import type { Operation } from "../shared/contracts.ts";
import { artifactLocalStorage } from "./artifact/artifact-local-storage.ts";
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const storageEpoch = artifactLocalStorage.authenticationEpoch();
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 || path === "/api/logout") artifactLocalStorage.suspend();
  const data = await response.json();
  if (path === "/api/session") {
    if (data.authenticated) artifactLocalStorage.resume(storageEpoch);
    else artifactLocalStorage.suspend();
  }
  if (!response.ok)
    throw new Error(
      data.error?.message ?? data.error_description ?? `Request failed (${response.status})`,
    );
  return data as T;
}
export async function call<T>(
  operation: Operation,
  input: Record<string, unknown> = {},
): Promise<T> {
  const result = (await request<{ result: T }>(`/api/operations/${operation}`, input)).result;
  if (operation === "artifacts_delete") artifactLocalStorage.forget(String(input.artifact_id));
  if (operation === "artifacts_gc")
    for (const id of (result as { deletedIds?: string[] }).deletedIds ?? [])
      artifactLocalStorage.forget(id);
  return result;
}
export function mutation() {
  return { operation_key: crypto.randomUUID() };
}
