import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";

import { createTestDatabase, createAuthUser, setRole } from "./helpers/test-database";

/**
 * Deactivation, against a real Postgres.
 *
 * Every rule here exists to prevent a workspace locking itself out of its own
 * administration — a state recoverable only by re-running the seed script
 * against production. So they are tested where they are enforced, in the
 * database transaction, rather than at the component that renders the button.
 *
 * Invitation is not covered here: it calls Supabase Auth, which this suite has
 * no business reaching. Its guard that *is* local — refusing an address already
 * in the workspace — is asserted below.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { setUserActive, countAdmins, changeUserRole, listUsers, inviteUser } = await import(
  "@/lib/repositories/users"
);

let client: PGlite;

/*
 * A fresh database per test, not a shared one wiped between them.
 *
 * `audit_logs` is append-only — a trigger refuses DELETE — which is exactly the
 * property an audit trail should have, and not one worth weakening so a test
 * suite can tidy up after itself. Booting a new in-process Postgres costs a few
 * hundred milliseconds and keeps the production constraint intact.
 */
beforeEach(async () => {
  client = await createTestDatabase();
  holder.db = drizzle(client, { schema });
});

afterAll(async () => {
  await client?.close();
});

async function admin(email: string): Promise<string> {
  const id = await createAuthUser(client, email);
  await setRole(client, id, "admin");
  return id;
}

async function viewer(email: string): Promise<string> {
  return createAuthUser(client, email);
}

describe("deactivating an account", () => {
  it("records the moment it happened, not merely a flag", async () => {
    const actor = await admin("boss@x.test");
    const target = await viewer("temp@x.test");

    const outcome = await setUserActive({ actorId: actor, targetUserId: target, active: false });

    expect(outcome.ok).toBe(true);

    const rows = await client.query<{ deactivated_at: string | null }>(
      "select deactivated_at from public.users where id = $1",
      [target],
    );

    // "When" is always the next question once "whether" matters.
    expect(rows.rows[0]!.deactivated_at).not.toBeNull();
  });

  it("writes an audit entry in the same transaction", async () => {
    const actor = await admin("boss@x.test");
    const target = await viewer("temp@x.test");

    await setUserActive({ actorId: actor, targetUserId: target, active: false });

    const logs = await client.query<{ action: string; entity_id: string }>(
      "select action, entity_id from audit_logs where action = 'user.deactivated'",
    );

    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]!.entity_id).toBe(target);
  });

  it("reactivates, and logs that separately", async () => {
    const actor = await admin("boss@x.test");
    const target = await viewer("temp@x.test");

    await setUserActive({ actorId: actor, targetUserId: target, active: false });
    const back = await setUserActive({ actorId: actor, targetUserId: target, active: true });

    expect(back.ok).toBe(true);

    const rows = await client.query<{ deactivated_at: string | null }>(
      "select deactivated_at from public.users where id = $1",
      [target],
    );
    expect(rows.rows[0]!.deactivated_at).toBeNull();

    const logs = await client.query<{ action: string }>(
      "select action from audit_logs order by created_at",
    );
    expect(logs.rows.map((r) => r.action)).toEqual(["user.deactivated", "user.reactivated"]);
  });
});

describe("the rules that prevent a lockout", () => {
  it("refuses to deactivate yourself", async () => {
    const actor = await admin("boss@x.test");
    await admin("second@x.test");

    const outcome = await setUserActive({ actorId: actor, targetUserId: actor, active: false });

    expect(outcome).toEqual({ ok: false, reason: "self_change" });
  });

  it("refuses to deactivate the only remaining admin", async () => {
    const actor = await admin("boss@x.test");
    const other = await admin("second@x.test");

    // Two admins: switching one off is fine.
    const first = await setUserActive({ actorId: actor, targetUserId: other, active: false });
    expect(first.ok).toBe(true);

    /*
     * Now `actor` is the only active admin. Another admin cannot exist to do
     * this, so the check is exercised through a reactivated third party — the
     * point is that the *count* is what protects the workspace.
     */
    const third = await admin("third@x.test");
    const demoteActor = await setUserActive({
      actorId: third,
      targetUserId: actor,
      active: false,
    });
    expect(demoteActor.ok).toBe(true);

    // Only `third` is active and admin now.
    const lastOne = await setUserActive({
      actorId: other,
      targetUserId: third,
      active: false,
    });
    expect(lastOne).toEqual({ ok: false, reason: "last_admin" });
  });

  it("rejects a no-op rather than writing a meaningless audit entry", async () => {
    const actor = await admin("boss@x.test");
    const target = await viewer("temp@x.test");

    const outcome = await setUserActive({ actorId: actor, targetUserId: target, active: true });

    expect(outcome).toEqual({ ok: false, reason: "no_change" });

    const logs = await client.query("select 1 from audit_logs");
    expect(logs.rows).toHaveLength(0);
  });

  it("rejects an account that does not exist", async () => {
    const actor = await admin("boss@x.test");

    const outcome = await setUserActive({
      actorId: actor,
      targetUserId: "00000000-0000-0000-0000-000000000000",
      active: false,
    });

    expect(outcome).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("a deactivated admin does not hold the workspace open", () => {
  it("is excluded from the admin count", async () => {
    const actor = await admin("boss@x.test");
    const other = await admin("second@x.test");

    expect(await countAdmins()).toBe(2);

    await setUserActive({ actorId: actor, targetUserId: other, active: false });

    /*
     * The subtle one. If a switched-off admin still counted, the last-admin
     * guard would happily let you demote the only person who can actually sign
     * in — the guard would report two admins where the workspace has one.
     */
    expect(await countAdmins()).toBe(1);
  });

  it("does not satisfy the last-admin guard on a demotion", async () => {
    const actor = await admin("boss@x.test");
    const other = await admin("second@x.test");
    const third = await admin("third@x.test");

    await setUserActive({ actorId: actor, targetUserId: other, active: false });
    await setUserActive({ actorId: actor, targetUserId: third, active: false });

    // `actor` is the only admin who can sign in. Demoting them must be refused
    // even though two other rows still say `admin`.
    const outcome = await changeUserRole({
      actorId: other,
      targetUserId: actor,
      newRole: "viewer",
    });

    expect(outcome).toEqual({ ok: false, reason: "last_admin" });
  });
});

describe("inviting someone", () => {
  it("refuses an address already in the workspace, before reaching Supabase", async () => {
    const actor = await admin("boss@x.test");
    await viewer("taken@x.test");

    /*
     * The duplicate check runs before the Auth client is constructed, which is
     * what makes this testable without a network. It also matters in its own
     * right: `inviteUserByEmail` on an existing address resends an invitation
     * and can reset a working account's credential.
     */
    const outcome = await inviteUser({
      actorId: actor,
      email: "TAKEN@x.test",
      fullName: null,
      role: "viewer",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("already_exists");
  });

  it("matches the address case-insensitively, as Supabase Auth does", async () => {
    const actor = await admin("boss@x.test");
    await viewer("Mixed.Case@x.test");

    const outcome = await inviteUser({
      actorId: actor,
      email: "mixed.case@X.TEST",
      fullName: null,
      role: "admin",
    });

    // Two rows differing only by case would desynchronise this table from
    // `auth.users`, which treats email as case-insensitive.
    expect(outcome.ok).toBe(false);
  });
});

describe("the roster reports activation state", () => {
  it("exposes deactivatedAt so the screen can show it", async () => {
    const actor = await admin("boss@x.test");
    const target = await viewer("temp@x.test");

    await setUserActive({ actorId: actor, targetUserId: target, active: false });

    const rows = await listUsers();
    const found = rows.find((row) => row.id === target);

    expect(found?.deactivatedAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.id === actor)?.deactivatedAt).toBeNull();
  });
});
