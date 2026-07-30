import { redirect } from "next/navigation";

import { DEFAULT_SIGNED_IN_PATH, LOGIN_PATH } from "@/lib/auth/route-policy";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Root entry point: straight to the dashboard when signed in, otherwise login. */
export default async function RootPage() {
  const user = await getCurrentUser();

  redirect(user ? DEFAULT_SIGNED_IN_PATH : LOGIN_PATH);
}
