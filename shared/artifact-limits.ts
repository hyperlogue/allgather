export const PUBLICATION_LIMITS = {
  files: 10_000,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  patchBytes: 10 * 1024 * 1024,
  markdownBytes: 4 * 1024 * 1024,
} as const;
