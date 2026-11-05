import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, type Principal } from "../shared/contracts.ts";
import { type MachineScope, machineScopes, wireId } from "../shared/tower-acp.ts";
import { hash, secret } from "./auth.ts";
import { uid, type Workspace } from "./workspace.ts";

const createSchema = z
  .object({
    host_id: wireId,
    tower_version: wireId,
    requested_scopes: machineScopes,
    node_label: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
const decisionSchema = z
  .object({
    decision: z.enum(["authorize", "deny"]),
    node_label: z.string().trim().min(1).max(160).optional(),
    scopes: machineScopes.optional(),
  })
  .strict();
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
const parse = <T>(schema: z.ZodType<T>, input: unknown) => {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError("invalid_input", "Invalid machine enrollment request", 400);
  return result.data;
};
export class TowerEnrollment {
  constructor(
    private w: Workspace,
    private origin: string,
  ) {}
  create(input: unknown) {
    const a = parse(createSchema, input),
      id = uid("enrollment"),
      token = secret(),
      at = this.w.now();
    // Bound unauthenticated durable state even across process restarts.
    this.w.run("DELETE FROM tower_enrollments WHERE expires_at<? AND credential_id IS NULL", at);
    if (
      this.w.one<{ n: number }>(
        "SELECT count(*) n FROM tower_enrollments WHERE expires_at>? AND state!='confirmed'",
        at,
      )!.n >= 100
    )
      throw new AppError("enrollment_capacity", "Too many pending machine enrollments", 429);
    const expires = new Date(Date.parse(at) + 600000).toISOString();
    this.w.run(
      "INSERT INTO tower_enrollments(id,poll_hash,host_id,tower_version,node_label,requested_scopes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
      id,
      hash(token),
      a.host_id,
      a.tower_version,
      a.node_label ?? "Tower node",
      JSON.stringify(a.requested_scopes),
      expires,
      at,
    );
    return {
      enrollment_id: id,
      authorization_url: `${this.origin}/tower/enroll/${id}`,
      polling_token: token,
      expires_at: expires,
      interval: 5,
    };
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
    const existing = this.w.one<{ name: string }>(
      "SELECT name FROM machines WHERE host_id=?",
      row.host_id,
    );
    return {
      enrollment_id: row.id,
      host_id: row.host_id,
      tower_version: row.tower_version,
      node_label: existing?.name ?? row.node_label,
      requested_scopes: JSON.parse(row.requested_scopes) as MachineScope[],
      state: row.state,
      expires_at: row.expires_at,
    };
  }
  decide(id: string, input: unknown, principal: Principal) {
    const a = parse(decisionSchema, input);
    return this.w.db
      .transaction(() => {
        const row = this.get(id);
        if (row.state !== "pending")
          throw new AppError(
            "enrollment_state",
            "This enrollment has already been decided or expired",
            409,
          );
        if (a.decision === "deny") {
          this.w.run("UPDATE tower_enrollments SET state='denied' WHERE id=?", id);
          return { state: "denied" };
        }
        const scopes = a.scopes ?? (JSON.parse(row.requested_scopes) as MachineScope[]);
        if (scopes.some((s) => !JSON.parse(row.requested_scopes).includes(s)))
          throw new AppError("invalid_scope", "Consent cannot grant a scope Tower did not request");
        let machine = this.w.one<{ id: string; revision: number; name: string }>(
          "SELECT id,revision,name FROM machines WHERE host_id=?",
          row.host_id,
        );
        const name = a.node_label ?? machine?.name ?? row.node_label;
        if (!machine) {
          machine = this.w.execute(
            "machines_create",
            { name, operation_key: `${id}:machine` },
            principal,
          ) as { id: string; revision: number; name: string };
          this.w.run("UPDATE machines SET host_id=? WHERE id=?", row.host_id, machine.id);
        } else if (a.node_label) {
          this.w.execute(
            "machines_update",
            {
              machine_id: machine.id,
              name,
              expected_revision: machine.revision,
              operation_key: `${id}:label`,
            },
            principal,
          );
        }
        this.w.run(
          "UPDATE tower_enrollments SET state='approved',scopes=?,node_label=?,machine_id=? WHERE id=?",
          JSON.stringify(scopes),
          name,
          machine.id,
          id,
        );
        return { state: "approved", machine_id: machine.id };
      })
      .immediate();
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
        this.w.run("UPDATE tower_enrollments SET state='confirmed' WHERE id=?", id);
        return { state: "confirmed", machine_id: row.machine_id, credential_id: row.credential_id };
      })
      .immediate();
  }
}
