export const PROJECT_ICON_MAX_BYTES = 1024 * 1024;
export const PROJECT_ICON_MAX_SIDE = 1024;
export const PROJECT_ICON_PREVIEW_SIDE = 128;
export const projectIconMediaTypes = ["image/png", "image/jpeg"] as const;
export interface ProjectIconUpload {
  media_type: (typeof projectIconMediaTypes)[number];
  base64: string;
}
export interface ProjectIconInfo {
  hash: string;
  media_type: ProjectIconUpload["media_type"];
}
export function projectIconUrl(project: { id: string; icon: ProjectIconInfo | null }) {
  return project.icon
    ? `/api/projects/${encodeURIComponent(project.id)}/icon?v=${project.icon.hash}`
    : null;
}
