import { fixtureApiToken } from "../../scripts/fixture-auth.ts";
import { createApp, Updates } from "../../server/app.ts";
import { Auth } from "../../server/auth.ts";
import type { Workspace } from "../../server/workspace.ts";
import type { Principal } from "../../shared/contracts.ts";
import type { HarnessControls } from "../../shared/tower-acp.ts";
export function fixtureOwner(w: Workspace): Principal {
  const auth = new Auth(w.db, "https://allgather.example");
  const cookie = auth.signIn(auth.createLoginToken("Runtime fixture").token).split(";")[0];
  const principal = auth.principal(new Request(auth.baseUrl, { headers: { cookie } }));
  if (!principal) throw new Error("Fixture authentication failed");
  return principal;
}
export async function fixtureAgent(
  w: Workspace,
  origin = "https://allgather.example",
): Promise<Principal> {
  const auth = new Auth(w.db, origin);
  const app = createApp(w, auth, new Updates());
  const cookie = auth.signIn(auth.createLoginToken("API fixture").token).split(";")[0];
  const token = await fixtureApiToken(origin, cookie, ["admin"], (request) => app.fetch(request));
  const principal = auth.principal(
    new Request(origin, { headers: { authorization: `Bearer ${token}` } }),
  );
  if (!principal) throw new Error("API fixture authentication failed");
  return principal;
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
