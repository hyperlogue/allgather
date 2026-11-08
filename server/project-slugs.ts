import type { Database } from "bun:sqlite";
import { suggestedProjectSlug } from "../shared/project-slug.ts";

export function availableProjectSlug(db: Database, name: string) {
  const base = suggestedProjectSlug(name);
  let slug = base;
  let suffix = 2;
  while (db.query("SELECT 1 FROM projects WHERE slug=?").get(slug)) slug = `${base}${suffix++}`;
  return slug;
}
