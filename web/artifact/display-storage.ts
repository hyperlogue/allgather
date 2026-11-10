// Display preferences may remain local to this page when storage is unavailable.
// Security decisions and authored content must use their own persistence policy.
const fallback = new Map<string, string | null>();

export function readDisplayPreference(key: string): string | null {
  if (fallback.has(key)) return fallback.get(key)!;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeDisplayPreference(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    fallback.delete(key);
  } catch {
    fallback.set(key, value);
  }
}
