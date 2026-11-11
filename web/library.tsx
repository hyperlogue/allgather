import { useEffect, useRef, useState } from "react";
import type { Artifact, ArtifactVersion } from "../shared/artifacts.ts";
import type { Page } from "../shared/contracts.ts";
import { call } from "./api.ts";
import { ContextLink } from "./context.tsx";
import { Icon } from "./icons.tsx";
import { scopeFilter, singleProject } from "./project-scope.ts";
import {
  Button,
  Dialog,
  EmptyState,
  ErrorText,
  PageHeading,
  Segmented,
  Select,
  useAction,
} from "./ui.tsx";

async function encode(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let data = "";
  for (let at = 0; at < bytes.length; at += 8192)
    data += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(data);
}
function Publication({
  project,
  artifact,
  close,
  published,
}: {
  project: string;
  artifact?: Artifact;
  close: () => void;
  published: (id: string) => void;
}) {
  const [kind, setKind] = useState(artifact?.kind ?? "html"),
    [title, setTitle] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [patch, setPatch] = useState(""),
    [label, setLabel] = useState(""),
    [summary, setSummary] = useState(""),
    [task, setTask] = useState(""),
    [created, setCreated] = useState<Artifact | undefined>(artifact),
    { busy, error, run } = useAction(),
    keys = useRef({ create: crypto.randomUUID(), publish: crypto.randomUUID() });
  return (
    <Dialog title={created ? "Publish a version" : "New artifact"} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            let content: Record<string, unknown>;
            if (kind === "diff") content = { kind, patch };
            else {
              if (!files.length) throw new Error("Choose files to publish");
              if (
                files.length > 10000 ||
                files.reduce((sum, f) => sum + f.size, 0) > 128 * 1024 * 1024 ||
                files.some((f) => f.size > 64 * 1024 * 1024)
              )
                throw new Error(
                  "A capture supports up to 10,000 files, 64 MiB per file, and 128 MiB in total",
                );
              content = {
                kind,
                files: await Promise.all(
                  files.map(async (f) => ({
                    path: f.webkitRelativePath
                      ? f.webkitRelativePath.split("/").slice(1).join("/")
                      : f.name,
                    mediaType: f.name.endsWith(".html")
                      ? "text/html"
                      : f.name.endsWith(".md")
                        ? "text/markdown"
                        : f.type || "application/octet-stream",
                    base64: await encode(f),
                  })),
                ),
              };
            }
            let record = created;
            if (!record) {
              record = await call<Artifact>("artifacts_create", {
                kind,
                title: title || undefined,
                project_id: project || undefined,
                task_id: task || undefined,
                operation_key: keys.current.create,
              });
              setCreated(record);
            }
            await call<ArtifactVersion>("artifacts_publish", {
              artifact_id: record.id,
              expected_seq: record.latestVersion?.seq ?? 0,
              content,
              label: label || undefined,
              summary: summary || undefined,
              task_id: task || undefined,
              operation_key: keys.current.publish,
            });
            published(record.id);
            close();
          });
        }}
      >
        {!created && (
          <>
            <label>
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </label>
            <label>
              Kind
              <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="html">HTML page</option>
                <option value="files">Files and documents</option>
                <option value="diff">Git diff</option>
              </Select>
            </label>
          </>
        )}
        {kind === "diff" ? (
          <label>
            Unified diff
            <textarea rows={10} required value={patch} onChange={(e) => setPatch(e.target.value)} />
          </label>
        ) : (
          <>
            <label>
              Files
              <input
                type="file"
                multiple
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </label>
            <label>
              Or choose a folder
              <input
                type="file"
                {...{ webkitdirectory: "" }}
                multiple
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </label>
            <p className="muted small">
              {files.length
                ? `${files.length} files selected.`
                : kind === "html"
                  ? "Include index.html and every asset the page needs."
                  : "Publish a complete file set for this version."}
            </p>
          </>
        )}
        <div className="form-row">
          <label>
            Version label
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label>
            Related task ID
            <input value={task} onChange={(e) => setTask(e.target.value)} />
          </label>
        </div>
        <label>
          What changed
          <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </label>
        <ErrorText>{error}</ErrorText>
        <div className="actions">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
const artifactStates: readonly (readonly [string, string])[] = [
  ["active", "Active"],
  ["archived", "Archived"],
];
export function LibraryView({
  scope,
  refresh,
  changed,
}: {
  scope: string[];
  refresh: number;
  changed: () => void;
}) {
  const project = singleProject(scope);
  const [page, setPage] = useState<Page<Artifact>>({ items: [], total: 0, next_cursor: null }),
    [state, setState] = useState("active"),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState(
      () => new URLSearchParams(location.search).get("artifact") ?? "",
    ),
    [detail, setDetail] = useState<Artifact | null>(null),
    [create, setCreate] = useState(false),
    [publish, setPublish] = useState(false),
    [cursor, setCursor] = useState(0),
    [error, setError] = useState(""),
    frame = useRef<HTMLIFrameElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh counters reload committed server state.
  useEffect(() => {
    let live = true;
    const request = query
      ? call<{ artifacts: Artifact[]; total: number; nextOffset: number | null }>(
          "artifacts_search",
          { query, ...scopeFilter(scope), state, cursor },
        ).then((r) => ({ items: r.artifacts, total: r.total, next_cursor: r.nextOffset }))
      : call<Page<Artifact>>("artifacts_list", { ...scopeFilter(scope), state, cursor });
    void request
      .then((p) => {
        if (live) {
          setPage(p);
          setError("");
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [scope, state, query, cursor, refresh]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh counters reload committed server state.
  useEffect(() => {
    let live = true;
    if (selected)
      void call<Artifact>("artifacts_get", { artifact_id: selected })
        .then((a) => live && setDetail(a))
        .catch((e) => live && setError(e.message));
    else setDetail(null);
    return () => {
      live = false;
    };
  }, [selected, refresh]);
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      if (
        e.origin === location.origin &&
        e.source === frame.current?.contentWindow &&
        e.data?.type === "allgather-artifact-deleted"
      ) {
        setSelected("");
        changed();
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [changed]);
  const opened = (id: string) => {
    setSelected(id);
    const url = new URL(location.href);
    url.searchParams.set("view", "artifacts");
    url.searchParams.set("artifact", id);
    history.replaceState(null, "", url);
    changed();
  };
  const back = () => {
    setSelected("");
    const url = new URL(location.href);
    url.searchParams.delete("artifact");
    url.searchParams.delete("version");
    history.replaceState(null, "", url);
  };
  if (selected)
    return (
      <div className="artifact-workspace">
        <div className="artifact-bar">
          <Button variant="quiet" onClick={back}>
            ← Library
          </Button>
          <span>{detail?.title ?? "Artifact"}</span>
          <ContextLink id={selected} />
          <div className="heading-actions">
            <a
              href={`/artifact-workspace/${encodeURIComponent(selected)}`}
              target="_blank"
              rel="noreferrer"
            >
              Open separately
            </a>
            <Button
              disabled={!detail || detail.state === "archived"}
              onClick={() => setPublish(true)}
            >
              Publish version
            </Button>
          </div>
        </div>
        <ErrorText>{error}</ErrorText>
        <iframe
          ref={frame}
          title="Artifact workspace"
          src={`/artifact-workspace/${encodeURIComponent(selected)}${new URLSearchParams(location.search).has("version") ? `?version=${encodeURIComponent(new URLSearchParams(location.search).get("version") ?? "")}` : ""}`}
          className="artifact-frame"
        />
        {publish && detail && (
          <Publication
            project={project}
            artifact={detail}
            close={() => setPublish(false)}
            published={opened}
          />
        )}
      </div>
    );
  return (
    <>
      <PageHeading>
        <div>
          <h1>Library</h1>
          <p>Published results and the discussion that moves work forward.</p>
        </div>
        <Button variant="primary" onClick={() => setCreate(true)}>
          New artifact
        </Button>
      </PageHeading>
      <div className="task-toolbar">
        <Segmented
          label="Artifact state"
          options={artifactStates}
          value={state}
          change={(v) => {
            setState(v);
            setCursor(0);
          }}
        />
        <label className="search">
          <span className="sr-only">Search library</span>
          <input
            placeholder="Search content and comments"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
          />
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      <section className="artifact-list">
        {page.items.map((a) => (
          <button type="button" className="artifact-row" key={a.id} onClick={() => opened(a.id)}>
            <span className={`artifact-kind ${a.kind}`}>
              <Icon name={a.kind} />
              {a.kind === "html" ? "Page" : a.kind === "files" ? "Files" : "Diff"}
            </span>
            <span>
              <strong>{a.title ?? a.id}</strong>
              <small>
                {a.latestVersion
                  ? `Version ${a.latestVersion.seq}${a.latestVersion.label ? ` · ${a.latestVersion.label}` : ""}`
                  : "No publication yet"}
                {a.unhandledCount ? ` · ${a.unhandledCount} replies to review` : ""}
              </small>
            </span>
            <small>{new Date(a.updatedAt).toLocaleDateString()}</small>
          </button>
        ))}
        {!page.items.length && (
          <EmptyState title="No artifacts here yet">
            Publish a page, document, or diff from the browser or CLI.
          </EmptyState>
        )}
      </section>
      <div className="pagination">
        <Button disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 50))}>
          Previous
        </Button>
        <Button
          disabled={page.next_cursor === null}
          onClick={() => setCursor(page.next_cursor ?? 0)}
        >
          Next
        </Button>
      </div>
      {create && (
        <Publication project={project} close={() => setCreate(false)} published={opened} />
      )}
    </>
  );
}
