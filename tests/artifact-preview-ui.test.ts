import { expect, test } from "bun:test";
import type { ArtifactDetail, ArtifactThread } from "../shared/artifacts.ts";
import { artifactMarkerTargets } from "../web/artifact/artifact-navigation.ts";
import { previewLinkAction } from "../web/artifact/preview-links.ts";

const thread = (id: string, status: ArtifactThread["status"]) =>
  ({
    id,
    artifactId: "artifact_markers",
    status,
    target: { kind: "rendered", versionSeq: 1, path: "index.html", locator: null },
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
    statusUnsent: false,
    comments: [],
    claim: null,
  }) as unknown as ArtifactThread;
const detail = (threads: ArtifactThread[]) =>
  ({ id: "artifact_markers", threads, placements: [] }) as unknown as ArtifactDetail;

test("rendered markers show only the selected discussion queue and flag resolved threads", () => {
  const open = thread("open-thread", "open"),
    resolved = thread("resolved-thread", "resolved"),
    artifact = detail([open, resolved]);
  expect(artifactMarkerTargets(artifact, 1, "open")).toEqual([
    expect.objectContaining({ threadId: "open-thread", resolved: false }),
  ]);
  expect(artifactMarkerTargets(artifact, 1, "resolved")).toEqual([
    expect.objectContaining({ threadId: "resolved-thread", resolved: true }),
  ]);
  expect(artifactMarkerTargets(artifact, 2, "open")).toEqual([]);
  expect(artifactMarkerTargets(detail([open]), 1, "resolved")).toEqual([]);
});

const app = "https://allgather.example";

test("artifact links on the app origin open in the artifact workspace", () => {
  expect(
    previewLinkAction(`${app}/artifact-workspace/artifact_Zs9AH?version=2#plan`, false, app),
  ).toEqual({
    kind: "artifact",
    id: "artifact_Zs9AH",
    href: "/artifact-workspace/artifact_Zs9AH?version=2#plan",
  });
  expect(
    previewLinkAction(`${app}/?view=artifacts&artifact=artifact_Zs9AH&version=3&x=1#a`, false, app),
  ).toEqual({
    kind: "artifact",
    id: "artifact_Zs9AH",
    href: "/artifact-workspace/artifact_Zs9AH?version=3#a",
  });
});

test("links leaving the app origin need confirmation", () => {
  for (const href of [
    "https://elsewhere.example/artifact-workspace/artifact_Zs?d=secret",
    "http://allgather.example/artifact-workspace/artifact_Zs",
    "https://allgather.example:8443/artifact-workspace/artifact_Zs",
  ])
    expect(previewLinkAction(href, false, app)).toEqual({ kind: "open", href, confirm: true });
});

test("same-origin links in a new tab or outside artifact routes open without confirmation", () => {
  for (const [href, newTab] of [
    [`${app}/artifact-workspace/artifact_Zs`, true],
    [`${app}/api/artifacts`, false],
    [`${app}/?view=tasks`, false],
    [`${app}/artifact-workspace/not-an-artifact`, false],
  ] as const)
    expect(previewLinkAction(href, newTab, app)).toEqual({ kind: "open", href, confirm: false });
});

test("non-web or malformed links are ignored", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,x", "not a url", 7, "x".repeat(9000)])
    expect(previewLinkAction(href, false, app)).toBeNull();
});
