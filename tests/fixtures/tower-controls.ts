import { hash } from "../../server/auth.ts";
import { setSetting, setting } from "../../server/storage.ts";
import type { Workspace } from "../../server/workspace.ts";
import type { Principal } from "../../shared/contracts.ts";
import type { HarnessControls } from "../../shared/tower-acp.ts";
export function fixtureOwner(w: Workspace): Principal {
  const binding = setting(w.db, "owner_key_hash") ?? hash("synthetic-test-owner");
  setSetting(w.db, "owner_key_hash", binding);
  return {
    id: "owner",
    kind: "owner",
    inlet: "browser",
    scopes: ["admin"],
    auth_binding: { kind: "owner", hash: binding },
  };
}
export const fullControls = (protocol: HarnessControls["protocol"] = "acp"): HarnessControls => ({
  protocol,
  capabilities: [
    "prompt",
    "resume",
    "permission_reply",
    "elicitation_reply",
    "configure",
    "image_input",
    "audio_input",
    "resource_input",
  ],
  cancel_mode: "turn",
});
