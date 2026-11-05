import { z } from "zod";
import { machineScopes, wireId } from "./tower-acp.ts";

export const pairingSecret = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const towerInvitationInput = z
  .object({
    node_label: z.string().trim().min(1).max(160).optional(),
    machine_id: wireId.optional(),
    scopes: machineScopes.default(["read", "send"]),
  })
  .strict();
export const towerEnrollmentInput = z
  .object({
    pairing_code: pairingSecret,
    request_id: pairingSecret,
    host_id: wireId,
    tower_version: wireId,
    requested_scopes: machineScopes,
    node_label: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
