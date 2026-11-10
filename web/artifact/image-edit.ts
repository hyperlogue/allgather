export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type ImageTool = "crop" | "pen" | "arrow" | "rectangle";
export interface ImagePoint {
  x: number;
  y: number;
}

// Crop evidence stays in the original captured pixels after an image is resized.
export function mapImageCrop(
  crop: ImageCrop,
  displayed: { width: number; height: number },
  original: ImageCrop,
): ImageCrop {
  const scaleX = original.width / displayed.width;
  const scaleY = original.height / displayed.height;
  return {
    x: original.x + crop.x * scaleX,
    y: original.y + crop.y * scaleY,
    width: crop.width * scaleX,
    height: crop.height * scaleY,
  };
}
export interface ImageDrawing {
  tool: Exclude<ImageTool, "crop">;
  points: ImagePoint[];
  color: string;
  width: number;
}
export interface ImageEdit {
  crop: ImageCrop | null;
  drawings: ImageDrawing[];
}
export interface ImageHistory {
  past: ImageEdit[];
  present: ImageEdit;
  future: ImageEdit[];
}
export const emptyImageHistory = (): ImageHistory => ({
  past: [],
  present: { crop: null, drawings: [] },
  future: [],
});
export function imageHistory(
  state: ImageHistory,
  action: { type: "edit"; value: ImageEdit } | { type: "undo" | "redo" | "reset" },
): ImageHistory {
  if (action.type === "reset") return emptyImageHistory();
  if (action.type === "edit")
    return { past: [...state.past, state.present].slice(-100), present: action.value, future: [] };
  if (action.type === "undo" && state.past.length)
    return {
      past: state.past.slice(0, -1),
      present: state.past.at(-1)!,
      future: [state.present, ...state.future],
    };
  if (action.type === "redo" && state.future.length)
    return {
      past: [...state.past, state.present],
      present: state.future[0]!,
      future: state.future.slice(1),
    };
  return state;
}
export function imageCrop(
  start: ImagePoint,
  end: ImagePoint,
  size: { width: number; height: number },
): ImageCrop {
  return {
    x: Math.min(size.width - 1, start.x, end.x),
    y: Math.min(size.height - 1, start.y, end.y),
    width: Math.max(1, Math.abs(end.x - start.x)),
    height: Math.max(1, Math.abs(end.y - start.y)),
  };
}

// Preview and export share the same image-coordinate drawing operations. The
// caller alone controls crop masking; it never becomes part of the saved image.
export function drawImageAnnotations(ctx: CanvasRenderingContext2D, drawings: ImageDrawing[]) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const drawing of drawings) {
    const start = drawing.points[0];
    const end = drawing.points.at(-1);
    if (!start || !end) continue;
    ctx.strokeStyle = ctx.fillStyle = drawing.color;
    ctx.lineWidth = drawing.width;
    ctx.beginPath();
    if (drawing.tool === "rectangle") {
      ctx.strokeRect(
        Math.min(start.x, end.x),
        Math.min(start.y, end.y),
        Math.abs(end.x - start.x),
        Math.abs(end.y - start.y),
      );
    } else if (drawing.tool === "arrow") {
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const head = Math.min(length * 0.45, Math.max(12, drawing.width * 3));
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x - Math.cos(angle) * head * 0.6, end.y - Math.sin(angle) * head * 0.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(
        end.x - head * Math.cos(angle - Math.PI / 6),
        end.y - head * Math.sin(angle - Math.PI / 6),
      );
      ctx.lineTo(
        end.x - head * Math.cos(angle + Math.PI / 6),
        end.y - head * Math.sin(angle + Math.PI / 6),
      );
      ctx.closePath();
      ctx.fill();
    } else if (drawing.points.length === 1) {
      ctx.arc(start.x, start.y, drawing.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(start.x, start.y);
      for (const point of drawing.points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}
