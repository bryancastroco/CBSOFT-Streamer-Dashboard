import { requireAdmin } from "@/lib/auth/guards";

/**
 * Every route under /admin is admin-only, enforced here on the server.
 *
 * Third layer of the same decision: middleware checks it at the edge, this
 * layout checks it during render, and each Server Action calls `assertAdmin()`
 * before mutating. A page that forgets its own check is still protected.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();

  return <>{children}</>;
}
