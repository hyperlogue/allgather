// All artifact requests use the owner's same-origin session. Never follow an
// application redirect or reuse an authenticated response from the HTTP cache.
export function applicationFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, redirect: "error", cache: "no-cache" });
}
