// These bounded lookup hints are not preview capabilities or authentication.
// Only authenticated application bootstrap may resolve them to scoped contexts.
export const PREVIEW_RESUME_COOKIE = "r3-preview-resume";
export const PREVIEW_RESUME_LIMIT = 16;

export function previewResumeKeys(value: string | undefined): string[] {
  if (!value || value.length > 1024) return [];
  return [...new Set(value.split(".").filter((key) => /^r[0-9a-f]{32}$/.test(key)))].slice(
    -PREVIEW_RESUME_LIMIT,
  );
}
