import type { Project } from "../shared/contracts.ts";

export interface ProjectTone {
  hue: number;
  chroma: number;
}
export function projectTone(project: Pick<Project, "slug">): ProjectTone {
  let hue = 50;
  for (const char of project.slug) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  return { hue, chroma: 0.12 };
}
export function toneColor(tone: ProjectTone) {
  return `oklch(var(--scope-l) ${tone.chroma.toFixed(3)} ${tone.hue.toFixed(0)})`;
}
export function projectColor(project: Pick<Project, "slug">) {
  return toneColor(projectTone(project));
}
export function scopeRail(projects: Pick<Project, "slug">[]) {
  if (!projects.length) return null;
  const tones = projects.map(projectTone);
  if (tones.length === 1) return toneColor(tones[0]);
  let x = 0,
    y = 0,
    total = 0;
  for (const tone of tones) {
    const angle = (tone.hue * Math.PI) / 180;
    x += tone.chroma * Math.cos(angle);
    y += tone.chroma * Math.sin(angle);
    total += tone.chroma;
  }
  if (Math.hypot(x, y) / total < 0.5)
    return `linear-gradient(to bottom, ${tones.map(toneColor).join(", ")})`;
  return toneColor({
    hue: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360,
    chroma: total / tones.length,
  });
}
export function scopeName(projects: Pick<Project, "name">[]) {
  if (!projects.length) return "All projects";
  if (projects.length === 1) return projects[0].name;
  if (projects.length === 2) return `${projects[0].name} + ${projects[1].name}`;
  return `${projects.length} projects`;
}
export function scopeFilter(scope: string[]) {
  return scope.length ? { project_ids: scope } : {};
}
export function singleProject(scope: string[]) {
  return scope.length === 1 ? scope[0] : "";
}
