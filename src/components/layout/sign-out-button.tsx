"use client";

import { useFormStatus } from "react-dom";
import { LogOut } from "lucide-react";

import { signOutAction } from "@/app/(auth)/login/actions";
import { Button } from "@/components/ui/button";

type SignOutButtonProps = {
  variant?: "ghost" | "outline" | "secondary";
  showIcon?: boolean;
};

function SubmitButton({
  variant,
  showIcon,
}: Required<Pick<SignOutButtonProps, "variant">> & {
  showIcon: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant={variant} size="sm" disabled={pending}>
      {showIcon ? <LogOut className="size-4" aria-hidden /> : null}
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}

/**
 * Sign-out is a POST through a Server Action, not a link.
 *
 * A GET that destroys the session can be triggered by any third-party page
 * embedding an image, which is a small but real denial-of-service. Server
 * Actions also carry framework CSRF protection.
 */
export function SignOutButton({ variant = "ghost", showIcon = false }: SignOutButtonProps) {
  return (
    <form action={signOutAction}>
      <SubmitButton variant={variant} showIcon={showIcon} />
    </form>
  );
}
