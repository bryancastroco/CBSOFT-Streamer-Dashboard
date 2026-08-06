"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AuthorizationError, assertAdmin } from "@/lib/auth/guards";
import { absoluteUrl } from "@/lib/config/app-origin";
import type { ActionState } from "@/lib/forms/action-state";
import { createInvitation, revokeInvitation } from "@/lib/repositories/page-connections";

/**
 * Creating and cancelling connection invitations.
 *
 * `assertAdmin` on both, as every mutation in this codebase does. The *public*
 * side of this feature authenticates with the invitation token instead — see
 * `src/app/connect/[token]/actions.ts`, which explains why that is not a hole.
 */

const inviteSchema = z.object({
  inviteeLabel: z.string().trim().min(1, "A name is required").max(120, "That name is too long"),
  inviteeEmail: z.string().trim().max(320).optional(),
  streamerId: z.uuid().optional(),
});

async function requireActor(): Promise<{ id: string } | ActionState> {
  try {
    const actor = await assertAdmin();
    return { id: actor.id };
  } catch (error) {
    if (error instanceof AuthorizationError) return { status: "error", message: error.message };
    throw error;
  }
}

function isActionState(value: unknown): value is ActionState {
  return typeof value === "object" && value !== null && "status" in value;
}

export async function createInvitationAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const streamerId = String(formData.get("streamerId") ?? "");

  const parsed = inviteSchema.safeParse({
    inviteeLabel: formData.get("inviteeLabel"),
    inviteeEmail: String(formData.get("inviteeEmail") ?? "").trim() || undefined,
    // Blank means "create a new streamer when they connect", which is the
    // common case for someone not on the roster yet.
    streamerId: streamerId.length > 0 ? streamerId : undefined,
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  }

  const invitation = await createInvitation({
    actorId: actor.id,
    inviteeLabel: parsed.data.inviteeLabel,
    inviteeEmail: parsed.data.inviteeEmail ?? null,
    streamerId: parsed.data.streamerId ?? null,
  });

  revalidatePath("/admin/connections");

  /*
   * The link comes back in the action result, which is the only time it will
   * ever exist outside the recipient's browser — the table stores a hash, so
   * nothing can show it again. Losing it means issuing another invitation,
   * which costs one click; the alternative is a table of live credentials in
   * plaintext.
   */
  return {
    status: "success",
    message: absoluteUrl(`/connect/${invitation.token}`),
  };
}

export async function revokeInvitationAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const outcome = await revokeInvitation({
    actorId: actor.id,
    id: String(formData.get("id") ?? ""),
  });

  revalidatePath("/admin/connections");

  return outcome.ok
    ? { status: "success", message: outcome.message }
    : { status: "error", message: outcome.message };
}
