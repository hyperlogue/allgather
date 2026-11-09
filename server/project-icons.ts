import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { AppError } from "../shared/contracts.ts";
import {
  PROJECT_ICON_MAX_BYTES,
  PROJECT_ICON_MAX_SIDE,
  type ProjectIconInfo,
  type ProjectIconUpload,
} from "../shared/project-icon.ts";
import { prepareAttachmentImage } from "./r3/server/attachment-image.ts";

export function projectIcon(db: Database, projectId: string) {
  return db
    .query<ProjectIconInfo, [string]>(
      "SELECT hash,media_type FROM project_icons WHERE project_id=?",
    )
    .get(projectId);
}
export function setProjectIcon(db: Database, projectId: string, icon: ProjectIconUpload | null) {
  if (icon === null) {
    db.query("DELETE FROM project_icons WHERE project_id=?").run(projectId);
    return;
  }
  const bytes = Buffer.from(icon.base64, "base64");
  if (
    !bytes.length ||
    bytes.length > PROJECT_ICON_MAX_BYTES ||
    bytes.toString("base64") !== icon.base64
  )
    throw new AppError("invalid_icon", "Use a PNG or JPEG icon up to 1 MiB with valid base64 data");
  let image: ReturnType<typeof prepareAttachmentImage>;
  try {
    image = prepareAttachmentImage(bytes, icon.media_type);
  } catch {
    throw new AppError("invalid_icon", "Use a valid static PNG or JPEG image");
  }
  if (image.width > PROJECT_ICON_MAX_SIDE || image.height > PROJECT_ICON_MAX_SIDE)
    throw new AppError("invalid_icon", "Project icons must be at most 1024 × 1024 pixels");
  const hash = createHash("sha256").update(image.bytes).digest("hex");
  db.query(`INSERT INTO project_icons(project_id,media_type,hash,bytes) VALUES(?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET media_type=excluded.media_type,hash=excluded.hash,bytes=excluded.bytes`).run(
    projectId,
    image.mediaType,
    hash,
    image.bytes,
  );
}
