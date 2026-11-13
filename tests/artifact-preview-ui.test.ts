import { expect, test } from "bun:test";
import type { ArtifactDetail, ArtifactThread } from "../shared/artifacts.ts";
import { artifactMarkerTargets } from "../web/artifact/artifact-navigation.ts";

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
