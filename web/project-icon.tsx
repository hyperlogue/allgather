import { useEffect, useRef, useState } from "react";
import type { Project } from "../shared/contracts.ts";
import {
  PROJECT_ICON_PREVIEW_SIDE,
  type ProjectIconUpload,
  projectIconUrl,
} from "../shared/project-icon.ts";
import { call, mutation } from "./api.ts";
import { Dialog, ErrorText, useAction } from "./ui.tsx";

export function ProjectIcon({ project }: { project: Project }) {
  const src = projectIconUrl(project);
  return src ? (
    <img className="project-icon" src={src} alt="" width={20} height={20} />
  ) : (
    <span className="project-dot" aria-hidden="true" />
  );
}
async function prepareIcon(file: File): Promise<ProjectIconUpload> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024)
    throw new Error("Choose a PNG, JPEG, or WebP image up to 5 MiB.");
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error("This image could not be opened. Choose another image.");
  }
  try {
    if (!image.width || !image.height || image.width * image.height > 20_000_000)
      throw new Error("Choose an image up to 20 megapixels.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = PROJECT_ICON_PREVIEW_SIDE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image resizing is unavailable in this browser.");
    const scale = PROJECT_ICON_PREVIEW_SIDE / Math.max(image.width, image.height);
    const width = image.width * scale,
      height = image.height * scale;
    context.drawImage(
      image,
      (canvas.width - width) / 2,
      (canvas.height - height) / 2,
      width,
      height,
    );
    return { media_type: "image/png", base64: canvas.toDataURL("image/png").split(",")[1] };
  } finally {
    image.close();
  }
}
export function ProjectIconInput({
  project,
  value,
  change,
  pending,
  disabled,
}: {
  project?: Project;
  value: ProjectIconUpload | null | undefined;
  change: (value: ProjectIconUpload | null) => void;
  pending: (value: boolean) => void;
  disabled: boolean;
}) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const src =
    value === undefined
      ? project
        ? projectIconUrl(project)
        : null
      : value
        ? `data:${value.media_type};base64,${value.base64}`
        : null;
  return (
    <fieldset className="project-icon-field" disabled={disabled}>
      <legend>Project icon</legend>
      <div className="project-icon-controls">
        <div className="project-icon-preview">
          {src ? (
            <img src={src} alt="Project icon preview" />
          ) : (
            <span className="project-dot" aria-hidden="true" />
          )}
        </div>
        <div className="project-icon-upload">
          <label>
            Upload image
            <input
              ref={input}
              type="file"
              onClick={(event) => {
                event.currentTarget.value = "";
              }}
              accept="image/png,image/jpeg,image/webp"
              disabled={disabled || loading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const token = ++generation.current;
                setError("");
                setLoading(true);
                pending(true);
                void prepareIcon(file)
                  .then((icon) => {
                    if (token === generation.current) change(icon);
                  })
                  .catch((error) => {
                    if (token === generation.current) setError(error.message);
                  })
                  .finally(() => {
                    if (token === generation.current) {
                      setLoading(false);
                      pending(false);
                    }
                  });
              }}
            />
          </label>
          <button
            type="button"
            className="quiet"
            disabled={disabled || (!src && !loading)}
            onClick={() => {
              generation.current++;
              if (input.current) input.current.value = "";
              setLoading(false);
              pending(false);
              setError("");
              change(null);
            }}
          >
            Remove icon
          </button>
        </div>
      </div>
      <p className="muted small">
        PNG, JPEG, or WebP up to 5 MiB. Images fit inside a 128 × 128 square.
      </p>
      {loading && <p role="status">Preparing image…</p>}
      <ErrorText>{error}</ErrorText>
    </fieldset>
  );
}
export function ProjectIconDialog({
  project,
  close,
  saved,
}: {
  project: Project;
  close: () => void;
  saved: () => void;
}) {
  const [icon, setIcon] = useState<ProjectIconUpload | null | undefined>();
  const [loading, setLoading] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <Dialog title={`Icon for ${project.name}`} close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (icon === undefined || loading) return;
          void run(async () => {
            await call("projects_update", {
              project_id: project.id,
              expected_revision: project.revision,
              icon,
              ...mutation(),
            });
            saved();
            close();
          });
        }}
      >
        <ProjectIconInput
          project={project}
          value={icon}
          change={setIcon}
          pending={setLoading}
          disabled={busy}
        />
        <ErrorText>{error}</ErrorText>
        <div className="actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || loading || icon === undefined}
          >
            Save icon
          </button>
        </div>
      </form>
    </Dialog>
  );
}
