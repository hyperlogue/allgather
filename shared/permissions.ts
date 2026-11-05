const permission = (category: string, label: string, defaultAllowed = false) => ({
  category,
  label,
  defaultAllowed,
});

export const permissions = {
  "tasks:read": permission("Tasks", "Read tasks and comments", true),
  "tasks:write": permission("Tasks", "Create and update tasks, comments, blockers and links", true),
  "projects:read": permission("Projects", "Read projects", true),
  "projects:write": permission("Projects", "Create projects and change their settings"),
  "repositories:read": permission(
    "Repositories",
    "Read repository settings and project mappings",
    true,
  ),
  "repositories:write": permission("Repositories", "Configure repositories and project mappings"),
  "repositories:sync": permission(
    "Repositories",
    "Fetch history and rebuild the local history cache",
  ),
  "commits:read": permission("Repositories", "Read commits and Git activity", true),
  "sessions:read": permission(
    "Sessions",
    "Read machines, checkouts, sessions and command status",
    true,
  ),
  "sessions:identity": permission("Sessions", "Declare local agent identities and assign roles"),
  "sessions:launch": permission("Sessions", "Launch a coding agent on a machine"),
  "sessions:prompt": permission("Sessions", "Send work to a running coding agent"),
  "sessions:stop": permission("Sessions", "Stop an agent turn or execution"),
  "sessions:resume": permission("Sessions", "Resume an earlier managed conversation"),
  "sessions:configure": permission("Sessions", "Change a managed agent's configuration"),
  "sessions:reply": permission("Sessions", "Answer native agent questions and permission requests"),
  "sessions:reconcile": permission("Sessions", "Reconcile uncertain command outcomes"),
  "sessions:assets": permission("Sessions", "Upload session assets"),
  "transcripts:read": permission("Transcripts", "Read retained agent conversations", true),
  "transcripts:import": permission("Transcripts", "Import historical conversations"),
  "artifacts:read": permission("Artifacts", "Read artifacts, source files and reviews", true),
  "artifacts:contribute": permission(
    "Artifacts",
    "Publish artifacts and contribute review comments",
    true,
  ),
  "artifacts:manage": permission(
    "Artifacts",
    "Archive, restore or permanently delete artifacts and threads",
  ),
  "artifacts:notify": permission("Artifacts", "Manage local agent notification subscriptions"),
  admin: permission("Administration", "Manage machine credentials, policy, storage and backups"),
} as const;
export type Scope = keyof typeof permissions;
export const scopes = Object.keys(permissions) as Scope[];
