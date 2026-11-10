export function AgentName({ id, labels }: { id: string; labels?: Record<string, string | null> }) {
  return <>{(labels && Object.hasOwn(labels, id) && labels[id]) || id}</>;
}
