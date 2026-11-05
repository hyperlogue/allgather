import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { OWNER } from "../server/auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import type {
  GitCommit,
  IndexedCommit,
  Operation,
  Page,
  Project,
  ProjectAttribution,
  Repository,
} from "../shared/contracts.ts";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const w = new Workspace(db, () => new Date("2026-01-02T12:00:00Z"));
  const call = <T>(name: Operation, input: Record<string, unknown> = {}, principal = OWNER) =>
    w.execute(name, { operation_key: randomUUID(), ...input }, principal) as T;
  // Read operations do not accept operation_key.
  const read = <T>(name: Operation, input: Record<string, unknown> = {}) =>
    w.execute(name, input, OWNER) as T;
  const project = (name: string) => call<Project>("projects_create", { name }).id;
  const a = project("Suite"),
    b = project("Web"),
    c = project("Unconfigured");
  const repo = call<Repository>("repositories_create", {
    project_id: a,
    name: "Monorepo",
    upstream_url: "https://example.invalid/mono.git",
    sync_enabled: false,
    path_prefixes: ["./apps/"],
  });
  const attach = (project: string, prefixes?: string[]) =>
    call<Repository>("repositories_attach", {
      repository_id: repo.id,
      project_id: project,
      ...(prefixes === undefined ? {} : { path_prefixes: prefixes }),
    });
  const set = (project: string, prefixes: string[]) =>
    call<Repository>("repositories_set_paths", {
      repository_id: repo.id,
      project_id: project,
      path_prefixes: prefixes,
      expected_revision: w.history
        .repository(repo.id)
        .project_links.find((link) => link.project_id === project)!.revision,
    });
  const match = (paths: string[], complete = true) =>
    read<ProjectAttribution>("repositories_match_projects", {
      repository_id: repo.id,
      paths,
      paths_complete: complete,
    });
  return { w, db, call, read, a, b, c, repo, attach, set, match };
}

test("project prefix lookup preserves single-project routing, longest matches, ties, and incomplete evidence", () => {
  const f = fixture();
  for (const field of [
    "project_id",
    "upstream_id",
    "refs",
    "history_limit",
    "collection_checkpoint",
  ])
    expect(field in f.repo).toBe(false);
  expect(f.repo.project_links).toEqual([{ project_id: f.a, path_prefixes: ["apps"], revision: 1 }]);
  expect(f.match([])).toMatchObject({ basis: "single_project", project_id: f.a });
  expect(f.match(["README.md"], false).project_id).toBe(f.a);
  f.attach(f.b, ["apps/web"]);
  f.attach(f.c);
  expect(f.match(["apps/web/main.ts"])).toMatchObject({
    project_ids: [f.b],
    project_id: f.b,
    basis: "path_prefix",
  });
  expect(f.match(["apps/api/main.ts"])).toMatchObject({ project_ids: [f.a], project_id: f.a });
  expect(f.match(["apps/web/main.ts", "apps/api/main.ts"]).project_ids.sort()).toEqual(
    [f.a, f.b].sort(),
  );
  expect(f.match(["apps/web/main.ts", "README.md"])).toMatchObject({
    project_id: null,
    unmatched_paths: ["README.md"],
  });
  expect(f.match(["appstore/main.ts", "Apps/web/main.ts"])).toMatchObject({
    project_ids: [],
    basis: "unassigned",
  });
  expect(f.match(["apps/web/main.ts"], false)).toMatchObject({
    project_ids: [f.b],
    project_id: null,
    paths_complete: false,
  });
  f.set(f.c, ["apps/web"]);
  expect(f.match(["apps/web/main.ts"])).toMatchObject({
    project_id: null,
    ambiguous_paths: ["apps/web/main.ts"],
  });
  expect(f.match(["apps/web/main.ts"]).project_ids.sort()).toEqual([f.b, f.c].sort());
  f.set(f.c, ["."]);
  expect(f.match(["README.md"])).toMatchObject({ project_id: f.c });
  expect(f.match(["apps/web/main.ts"])).toMatchObject({ project_id: f.b });
  expect(f.match([])).toMatchObject({ project_id: null, project_ids: [] });
});

test("project history search, pagination, and summaries agree with explicit lookup without rescanning Git", () => {
  const f = fixture();
  f.attach(f.b, ["apps/web"]);
  f.attach(f.c);
  const paths = [
    ["apps/api/a.ts"],
    ["apps/web/b.ts"],
    ["apps/api/a.ts", "apps/web/b.ts"],
    ["README.md"],
    ["appstore/c.ts"],
    [],
    ["apps/web/partial.ts"],
    ["apps/ui_/x.ts"],
    ["apps/ui1/x.ts"],
  ];
  const commits: GitCommit[] = paths.map((names, index) => ({
    id: (index + 1).toString(16).padStart(40, "0"),
    parents: [],
    message: `Delivery ${index}`,
    authored_at: "2026-01-01T00:00:00.000Z",
    committed_at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    files: names.map((path) => ({ path, additions: null, deletions: null })),
    files_complete: index !== 6,
    files_observed: index !== 5,
  }));
  f.w.history.completeSync(
    f.repo,
    {
      commits,
      refs: { main: commits[0].id },
      truncated: false,
      cacheMode: "filtered",
      checkpoint: { refs: { main: commits[0].id }, depth: commits.length },
    },
    "2099-01-01T00:00:00.000Z",
  );
  const all = () =>
    f.read<Page<IndexedCommit>>("history_search", {
      repository_id: f.repo.id,
      query: "Delivery",
      limit: 100,
    });
  expect(all().total).toBe(commits.length);
  const verify = () => {
    for (const project of [f.a, f.b, f.c]) {
      const expected = commits
        .filter((commit) =>
          f
            .match(
              commit.files.map((file) => file.path),
              commit.files_complete,
            )
            .project_ids.includes(project),
        )
        .map((commit) => commit.id)
        .sort();
      const first = f.read<Page<IndexedCommit>>("history_search", {
        project_id: project,
        query: "Delivery",
        limit: 2,
      });
      expect(first.total).toBe(expected.length);
      const ids = first.items.map((commit) => commit.id);
      let cursor = first.next_cursor;
      while (cursor !== null) {
        const page = f.read<Page<IndexedCommit>>("history_search", {
          project_id: project,
          query: "Delivery",
          limit: 2,
          cursor,
        });
        ids.push(...page.items.map((commit) => commit.id));
        cursor = page.next_cursor;
      }
      expect(ids.sort()).toEqual(expected);
      const summary = f.read<{ total: number; paths: { path: string }[] }>("history_summary", {
        project_id: project,
      });
      expect(summary.total).toBe(expected.length);
      expect(
        summary.paths.every((file) => f.match([file.path]).project_ids.includes(project)),
      ).toBe(true);
    }
    for (const commit of all().items)
      expect(commit.project_attribution).toEqual(
        f.match(
          commit.files.map((file) => file.path),
          commit.files_complete,
        ),
      );
  };
  verify();
  f.set(f.c, ["apps/web"]);
  verify();
  f.set(f.c, ["."]);
  verify();
  f.set(f.c, ["apps/ui_"]);
  verify();
  f.set(f.a, []);
  verify();
  expect(f.w.history.repository(f.repo.id).revision).toBe(f.repo.revision);
  expect(f.w.all("SELECT * FROM scans")).toHaveLength(1);
  f.call("repositories_attach", { repository_id: f.repo.id, project_id: f.a, remove: true });
  f.call("repositories_attach", { repository_id: f.repo.id, project_id: f.c, remove: true });
  expect(f.read<Page<IndexedCommit>>("history_search", { project_id: f.b }).total).toBe(
    commits.length,
  );
});

test("prefix configuration has independent revision, audit, retry, and scope guards", () => {
  const f = fixture();
  for (const prefix of ["/etc", "../apps", "apps/../secret", "C:\\work", "", "apps//web"])
    expect(() => f.set(f.a, [prefix])).toThrow("Invalid request");
  const input = {
    repository_id: f.repo.id,
    project_id: f.a,
    expected_revision: 1,
    path_prefixes: ["apps/web/", "apps/web"],
    operation_key: "paths-retry",
  };
  const changed = f.call<Repository>("repositories_set_paths", input);
  expect(changed.project_links[0]).toMatchObject({ path_prefixes: ["apps/web"], revision: 2 });
  expect(f.call<Repository>("repositories_set_paths", input)).toEqual(changed);
  expect(() => f.call("repositories_set_paths", { ...input, operation_key: "stale" })).toThrow(
    "link revision",
  );
  expect(() =>
    f.call("repositories_set_paths", { ...input, path_prefixes: ["elsewhere"] }),
  ).toThrow("different request");
  expect(() =>
    f.call(
      "repositories_set_paths",
      { ...input, expected_revision: 2, operation_key: "readonly" },
      { id: "reader", kind: "client", scopes: ["repositories:read"] },
    ),
  ).toThrow("repositories:write");
  expect(() => f.attach(f.a, ["other"])).toThrow("existing link");
  expect(
    f.w.all("SELECT * FROM audit_operations WHERE operation='repositories_set_paths'"),
  ).toHaveLength(1);
  expect(
    f.w.one<{ after_value: string }>(
      "SELECT after_value FROM audit_changes WHERE entity_type='project_repositories' AND change_kind='update'",
    )?.after_value,
  ).toContain("apps/web");
});
