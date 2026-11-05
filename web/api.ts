import type { Operation } from "../shared/contracts.ts";
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
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
  return (await request<{ result: T }>(`/api/operations/${operation}`, input)).result;
}
export function mutation() {
  return { operation_key: crypto.randomUUID() };
}
