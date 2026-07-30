import type { Metadata } from "next";

import { RoleForm } from "@/app/(app)/admin/users/role-form";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AUDIT_ACTION_LABELS } from "@/lib/audit/actions";
import { requireAdmin } from "@/lib/auth/guards";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/auth/roles";
import { listRecentAuditLogs, listUsers } from "@/lib/repositories/users";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

export default async function AdminUsersPage() {
  // Re-checked here even though the admin layout already did: this page reads
  // the full user table with the service role, so it proves its own authority.
  const currentUser = await requireAdmin();

  const [users, auditEntries] = await Promise.all([listUsers(), listRecentAuditLogs(15)]);

  return (
    <>
      <PageHeader
        title="Users"
        description="Every account with access to this workspace, and the role it holds."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounts</CardTitle>
          <CardDescription>
            New accounts are provisioned as viewers. Promote deliberately — an admin can manage
            streamers, Page tokens and synchronisation.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="text-right">Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="font-medium">{user.fullName ?? user.email}</div>
                    {user.fullName ? (
                      <div className="text-xs text-muted-foreground">{user.email}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.role === "admin" ? "default" : "secondary"}>
                      {ROLE_LABELS[user.role]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(user.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end">
                      <RoleForm
                        userId={user.id}
                        currentRole={user.role}
                        isSelf={user.id === currentUser.id}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}

              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    No accounts yet. Run the seed script to create the first admin.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {(["admin", "viewer"] as const).map((role) => (
          <Card key={role}>
            <CardHeader>
              <CardTitle className="text-base">{ROLE_LABELS[role]}</CardTitle>
              <CardDescription>{ROLE_DESCRIPTIONS[role]}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent activity</CardTitle>
          <CardDescription>
            Append-only audit trail. Role changes are recorded in the same transaction that applies
            them.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditEntries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                    {formatDate(entry.createdAt)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {AUDIT_ACTION_LABELS[entry.action] ?? entry.action}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {entry.actorEmail ?? "system"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {formatAuditDetail(entry.metadata)}
                  </TableCell>
                </TableRow>
              ))}

              {auditEntries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    Nothing recorded yet.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

/** Render audit metadata compactly. Metadata never contains secrets by policy. */
function formatAuditDetail(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") return "—";

  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length === 0) return "—";

  return entries.map(([key, value]) => `${key}=${String(value)}`).join(" ");
}
