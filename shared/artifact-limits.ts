export const PUBLICATION_LIMITS = {
  files: 10_000,
  fileBytes: 256 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  patchBytes: 10 * 1024 * 1024,
  markdownBytes: 4 * 1024 * 1024,
} as const;

export const UPLOAD_LIMITS = {
  partBytes: 16 * 1024 * 1024,
  parts: 4096,
  ttlMs: 24 * 60 * 60 * 1000,
} as const;
