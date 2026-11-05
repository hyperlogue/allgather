import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, type Principal } from "../shared/contracts.ts";
import { type MachineScope, wireId } from "../shared/tower-acp.ts";
import { towerEnrollmentInput, towerInvitationInput } from "../shared/tower-enrollment.ts";
import { hash, isBrowserOwner, secret } from "./auth.ts";
import { canonical, digest, uid, type Workspace } from "./workspace.ts";

interface Enrollment {
  id: string;
  poll_hash: string;
  host_id: string;
  tower_version: string;
  node_label: string;
  requested_scopes: string;
  scopes: string;
  state: string;
  expires_at: string;
  last_poll_at: string | null;
  machine_id: string | null;
  credential_id: string | null;
}
interface Invitation {
  id: string;
  code_hash: string;
  machine_id: string | null;
  node_label: string | null;
  scopes: string;
  owner: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  enrollment_id: string | null;
  request_fingerprint: string | null;
}
const parse = <T>(schema: z.ZodType<T>, input: unknown) => {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError("invalid_input", "Invalid Tower pairing request", 400);
  return result.data;
};
export class TowerEnrollment {
  constructor(
    private w: Workspace,
    private origin: string,
  ) {}
  private owner(p: Principal) {
    if (!isBrowserOwner(this.w.db, p, this.w.now()))
      throw new AppError("forbidden", "Start pairing from the owner browser", 403);
  }
  invite(input: unknown, owner: Principal) {
    this.owner(owner);
    const a = parse(towerInvitationInput, input),
      at = this.w.now();
    if (a.machine_id) {
      const machine = this.w.executions.machine(a.machine_id);
      if (!machine.host_id)
        throw new AppError(
          "unbound_machine",
          "Choose a machine with an established Tower host identity",
        );
    }
    const count = this.w.one<{ n: number }>(
      "SELECT count(*) n FROM tower_invitations i LEFT JOIN tower_enrollments e ON e.id=i.enrollment_id WHERE i.revoked_at IS NULL AND i.expires_at>? AND COALESCE(e.state,'open')!='confirmed'",
      at,
    )!.n;
    if (count >= 100)
      throw new AppError(
        "invitation_capacity",
        "Cancel an unused pairing code before creating another",
        429,
      );
    const code = secret(),
      id = uid("invitation"),
      expires = new Date(Date.parse(at) + 600000).toISOString();
    this.w.run(
      "INSERT INTO tower_invitations(id,code_hash,machine_id,node_label,scopes,owner,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      id,
      hash(code),
      a.machine_id ?? null,
      a.node_label ?? null,
      JSON.stringify(a.scopes),
      canonical(owner),
      at,
      expires,
    );
    return { invitation_id: id, pairing_code: code, expires_at: expires, server_url: this.origin };
  }
  invitations(owner: Principal) {
    this.owner(owner);
    return this.w
      .all<Invitation>("SELECT * FROM tower_invitations ORDER BY created_at DESC,id DESC LIMIT 200")
      .map((row) => {
        const e = row.enrollment_id ? this.get(row.enrollment_id) : null;
        return {
          invitation_id: row.id,
          machine_id: e?.machine_id ?? row.machine_id,
          node_label: e?.node_label ?? row.node_label,
          scopes: JSON.parse(row.scopes),
          granted_scopes: e ? JSON.parse(e.scopes) : null,
          enrollment_id: row.enrollment_id,
          expires_at: row.expires_at,
          state:
            row.revoked_at || e?.state === "denied"
              ? "revoked"
              : e?.state === "confirmed"
                ? "confirmed"
                : row.expires_at <= this.w.now()
                  ? "expired"
                  : e
                    ? "claimed"
                    : "open",
        };
      });
  }
  revokeInvitation(id: string, owner: Principal) {
    this.owner(owner);
    return this.w.db
      .transaction(() => {
        const i = this.w.one<Invitation>("SELECT * FROM tower_invitations WHERE id=?", id);
        if (!i) throw new AppError("not_found", "Pairing invitation not found", 404);
        const e = i.enrollment_id ? this.get(i.enrollment_id) : null;
        if (e?.state === "confirmed")
          throw new AppError(
            "pairing_complete",
            "Pairing is complete; revoke the machine credential instead",
            409,
          );
        if (e?.credential_id) this.w.executions.revokeCredential(e.credential_id);
        if (e) this.w.run("UPDATE tower_enrollments SET state='denied' WHERE id=?", e.id);
        this.w.run("UPDATE tower_invitations SET revoked_at=? WHERE id=?", this.w.now(), id);
        return { revoked: true };
      })
      .immediate();
  }
  private pollingToken(id: string, code: string, request: string) {
    return createHash("sha256")
      .update(`Allgather tower pairing poll v1\0${id}\0${code}\0${request}`)
      .digest("base64url");
  }
  create(input: unknown) {
    const a = parse(towerEnrollmentInput, input);
    return this.w.db
      .transaction(() => {
        const invitation = this.w.one<Invitation>(
          "SELECT * FROM tower_invitations WHERE code_hash=?",
          hash(a.pairing_code),
        );
        if (!invitation || invitation.revoked_at || invitation.expires_at <= this.w.now())
          throw new AppError(
            "invalid_pairing_code",
            "The owner must create a valid pairing code in the private web app",
            401,
          );
        const fingerprint = digest(canonical(a));
        let id = invitation.enrollment_id;
        if (id) {
          if (invitation.request_fingerprint !== fingerprint)
            throw new AppError(
              "pairing_conflict",
              "This code is bound to a different pairing request",
              409,
            );
          const e = this.get(id);
          if (e.state === "confirmed")
            throw new AppError("pairing_complete", "This code has already completed pairing", 409);
          if (e.state !== "approved")
            throw new AppError("invalid_pairing_code", "This pairing is no longer available", 401);
        } else {
          const scopes = a.requested_scopes.filter((scope) =>
            (JSON.parse(invitation.scopes) as MachineScope[]).includes(scope),
          );
          if (!scopes.length)
            throw new AppError(
              "invalid_scope",
              "The code grants none of the locally requested capabilities",
              403,
            );
          const known = this.w.one<{
            id: string;
            host_id: string | null;
            name: string;
            revision: number;
          }>("SELECT id,host_id,name,revision FROM machines WHERE host_id=?", a.host_id);
          if (invitation.machine_id ? known?.id !== invitation.machine_id : !!known)
            throw new AppError(
              "pairing_target_conflict",
              "Create a code for the exact existing node, or pair a new host",
              409,
            );
          id = uid("enrollment");
          const owner = JSON.parse(invitation.owner) as Principal;
          const name = invitation.node_label ?? known?.name ?? a.node_label ?? "Tower node";
          const machine =
            known ??
            (this.w.execute(
              "machines_create",
              { name, operation_key: `${invitation.id}:machine` },
              owner,
            ) as { id: string; revision: number; name: string });
          if (!known) this.w.run("UPDATE machines SET host_id=? WHERE id=?", a.host_id, machine.id);
          else if (invitation.node_label && invitation.node_label !== known.name)
            this.w.execute(
              "machines_update",
              {
                machine_id: known.id,
                name,
                expected_revision: known.revision,
                operation_key: `${invitation.id}:label`,
              },
              owner,
            );
          const poll = this.pollingToken(id, a.pairing_code, a.request_id);
          this.w.run(
            "INSERT INTO tower_enrollments(id,poll_hash,host_id,tower_version,node_label,requested_scopes,scopes,state,expires_at,created_at,machine_id) VALUES(?,?,?,?,?,?,?,'approved',?,?,?)",
            id,
            hash(poll),
            a.host_id,
            a.tower_version,
            name,
            JSON.stringify(a.requested_scopes),
            JSON.stringify(scopes),
            invitation.expires_at,
            this.w.now(),
            machine.id,
          );
          this.w.run(
            "UPDATE tower_invitations SET enrollment_id=?,request_fingerprint=? WHERE id=?",
            id,
            fingerprint,
            invitation.id,
          );
        }
        const poll = this.pollingToken(id, a.pairing_code, a.request_id);
        return {
          enrollment_id: id,
          authorization_url: `${this.origin}/tower/enroll/${id}`,
          polling_token: poll,
          expires_at: invitation.expires_at,
          interval: 5,
        };
      })
      .immediate();
  }
  private get(id: string) {
    const row = this.w.one<Enrollment>("SELECT * FROM tower_enrollments WHERE id=?", id);
    if (!row) throw new AppError("not_found", "Machine enrollment not found", 404);
    if (row.state !== "confirmed" && row.expires_at <= this.w.now()) {
      if (row.credential_id) this.w.executions.revokeCredential(row.credential_id);
      this.w.run("UPDATE tower_enrollments SET state='expired' WHERE id=?", id);
      row.state = "expired";
    }
    return row;
  }
  info(id: string) {
    const row = this.get(id);
    return {
      enrollment_id: row.id,
      machine_id: row.machine_id,
      host_id: row.host_id,
      tower_version: row.tower_version,
      node_label: row.node_label,
      requested_scopes: JSON.parse(row.requested_scopes) as MachineScope[],
      scopes: JSON.parse(row.scopes) as MachineScope[],
      state: row.state,
      expires_at: row.expires_at,
    };
  }
  private authorized(id: string, token: string) {
    if (
      !token ||
      !this.w.one("SELECT 1 FROM tower_enrollments WHERE id=? AND poll_hash=?", id, hash(token))
    )
      throw new AppError("unauthorized", "Private enrollment polling credential required", 401);
    return this.get(id);
  }
  private key(id: string, token: string) {
    return createHash("sha256")
      .update(`Allgather tower enrollment key v1\0${id}\0${token}`)
      .digest("base64url");
  }
  poll(id: string, token: string) {
    return this.w.db
      .transaction(() => {
        const row = this.authorized(id, token),
          now = this.w.now();
        if (row.last_poll_at && Date.parse(now) - Date.parse(row.last_poll_at) < 5000)
          throw new AppError("slow_down", "Poll at most once every five seconds", 429, {
            interval: 5,
          });
        this.w.run("UPDATE tower_enrollments SET last_poll_at=? WHERE id=?", now, id);
        if (row.state !== "approved") return { state: row.state, interval: 5 };
        const key = this.key(id, token);
        let credentialId = row.credential_id;
        if (!credentialId) {
          credentialId = this.w.executions.issueCredential(
            row.machine_id!,
            row.node_label,
            JSON.parse(row.scopes),
            key,
          ).id;
          this.w.run("UPDATE tower_enrollments SET credential_id=? WHERE id=?", credentialId, id);
        } else if (!this.w.executions.authenticate(key)) {
          this.w.run("UPDATE tower_enrollments SET state='denied' WHERE id=?", id);
          return { state: "denied", interval: 5 };
        }
        return {
          state: "approved",
          machine_id: row.machine_id,
          credential_id: credentialId,
          access_key: key,
          node_label: row.node_label,
          scopes: JSON.parse(row.scopes),
          expires_at: row.expires_at,
          interval: 5,
        };
      })
      .immediate();
  }
  confirm(id: string, token: string, input: unknown) {
    const a = parse(
      z
        .object({ credential_id: wireId, access_key_hash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
      input,
    );
    return this.w.db
      .transaction(() => {
        const row = this.authorized(id, token);
        if (
          !["approved", "confirmed"].includes(row.state) ||
          row.credential_id !== a.credential_id ||
          hash(this.key(id, token)) !== a.access_key_hash
        )
          throw new AppError(
            "enrollment_state",
            "Persist the approved credential before confirming",
            409,
          );
        if (!this.w.executions.authenticate(this.key(id, token)))
          throw new AppError("credential_revoked", "The machine credential was revoked", 409);
        if (row.state !== "confirmed")
          this.w.run(
            "UPDATE tower_credentials SET revoked_at=? WHERE machine_id=? AND id!=? AND revoked_at IS NULL",
            this.w.now(),
            row.machine_id,
            row.credential_id,
          );
        this.w.run("UPDATE tower_enrollments SET state='confirmed' WHERE id=?", id);
        return { state: "confirmed", machine_id: row.machine_id, credential_id: row.credential_id };
      })
      .immediate();
  }
}
