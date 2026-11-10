import type { ArtifactActor } from "./artifacts.ts";

export type ListenerRole = "fallback" | "explicit";
export interface WorkerSubscription {
  id: string;
  artifactId: string;
  listenerId: string;
  actor: ArtifactActor;
  mode: ListenerRole;
}
