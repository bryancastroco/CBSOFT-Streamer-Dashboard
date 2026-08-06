"use server";

import { revalidatePath } from "next/cache";

import { isUsable } from "@/lib/connect/invitations";
import type { ActionState } from "@/lib/forms/action-state";
import { connectChosenPage } from "@/lib/services/connect-page";
import { findInvitationByToken } from "@/lib/repositories/page-connections";

/**
 * The Server Action behind the Page choice.
 *
 * ## Why this one has no `assertAdmin`
 *
 * Every other Server Action in this codebase starts with an admin check. This
 * one deliberately does not: the caller is a streamer who has no dashboard
 * account and never will. The invitation token is the credential, and it is
 * re-resolved here rather than trusted from the form — a hidden field naming an
 * invitation id would let anyone attach a Page to any invitation.
 *
 * What bounds the damage if a link leaks: the holder can attach a Facebook Page
 * they personally administer, once, to one invitation, until it expires or is
 * revoked. They gain no read access to anything. That is the same exposure as
 * the link itself, which is the point of issuing one.
 */
export async function connectPageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const token = String(formData.get("token") ?? "");
  const pageId = String(formData.get("pageId") ?? "");

  if (!token || !pageId) {
    return { status: "error", message: "Choose a Page to continue." };
  }

  // Resolved from the token, never from the form. The form may name a Page;
  // it may not name which invitation is being spent.
  const invitation = await findInvitationByToken(token);

  if (!invitation || !isUsable(invitation)) {
    return { status: "error", message: "This link is no longer valid. Ask CBSOFT for a new one." };
  }

  const outcome = await connectChosenPage({
    connectionId: invitation.id,
    inviteeLabel: invitation.inviteeLabel,
    streamerId: invitation.streamerId,
    pageId,
  });

  if (!outcome.ok) return { status: "error", message: outcome.message };

  revalidatePath(`/connect/${token}`);
  revalidatePath("/admin/connections");
  revalidatePath("/admin/streamers");

  return {
    status: "success",
    message: outcome.warning
      ? `${outcome.pageName} is connected, with one thing to check: ${outcome.warning}`
      : `${outcome.pageName} is connected. Nothing else is needed from you.`,
  };
}
