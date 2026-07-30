import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  FileText,
  LayoutDashboard,
  MessagesSquare,
  Settings,
  ShieldCheck,
  Users,
  Video,
} from "lucide-react";

import type { Permission } from "@/lib/auth/roles";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  description: string;
  /**
   * Permission needed to see the link.
   *
   * Filtering the sidebar is presentation, not access control — the route
   * itself is protected by middleware and by a server-side guard. This only
   * avoids showing people links that would bounce them to /unauthorized.
   */
  permission: Permission;
};

export const mainNav: readonly NavItem[] = [
  {
    title: "Dashboard",
    href: "/dashboard",
    icon: LayoutDashboard,
    description: "Overview of streamer performance across the roster.",
    permission: "dashboard.view",
  },
  {
    title: "Streamers",
    href: "/streamers",
    icon: Users,
    description: "Roster of connected Facebook Pages and their metrics.",
    permission: "streamers.view",
  },
  {
    title: "Posts",
    href: "/posts",
    icon: FileText,
    description: "Published Facebook Page posts and their Meta insights.",
    permission: "posts.view",
  },
  {
    title: "Videos",
    href: "/videos",
    icon: Video,
    description: "Page videos and their Meta insights.",
    permission: "videos.view",
  },
  {
    title: "Comment analysis",
    href: "/comment-analysis",
    icon: MessagesSquare,
    description: "AI summaries of comments on posts and videos.",
    permission: "analysis.view",
  },
  {
    title: "Reports",
    href: "/reports",
    icon: BarChart3,
    description: "Period reports and Google Sheets exports.",
    permission: "reports.view",
  },
  {
    title: "Admin",
    href: "/admin",
    icon: ShieldCheck,
    description: "Users, Page connections and sync jobs.",
    permission: "users.manage",
  },
  {
    title: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Workspace configuration and integration status.",
    permission: "dashboard.view",
  },
] as const;
