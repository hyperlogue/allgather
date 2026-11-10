import {
  PREVIEW_RESUME_COOKIE,
  PREVIEW_RESUME_LIMIT,
  previewResumeKeys,
} from "../../shared/preview-resume.ts";

function write(keys: string[]) {
  // biome-ignore lint/suspicious/noDocumentCookie: Navigation needs this hint synchronously.
  document.cookie = `${PREVIEW_RESUME_COOKIE}=${keys.join(".")}; Path=/; SameSite=Strict${location.protocol === "https:" ? "; Secure" : ""}${keys.length ? "" : "; Max-Age=0"}`;
}

export function rememberPreviewContext(key: string | undefined) {
  if (previewResumeKeys(key).length !== 1) return;
  try {
    const value = document.cookie
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${PREVIEW_RESUME_COOKIE}=`))
      ?.slice(PREVIEW_RESUME_COOKIE.length + 1);
    write(
      [...previewResumeKeys(value).filter((saved) => saved !== key), key!].slice(
        -PREVIEW_RESUME_LIMIT,
      ),
    );
  } catch {
    // Cookie restrictions affect only the optimization, never retained URLs.
  }
}

export function clearPreviewResumeHints() {
  try {
    write([]);
  } catch {
    // Hints alone cannot authenticate or read preview content.
  }
}
