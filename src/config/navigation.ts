import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BookOpen,
  Bot,
  FileText,
  History,
  LayoutDashboard,
  MessagesSquare,
  Plug,
  Settings,
  Share2,
  Sliders,
  Table2,
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
   * itself is protected by the proxy and by a server-side guard. This only
   * avoids showing people links that would bounce them to /unauthorized.
   */
  permission: Permission;
  /** Marks a screen that is deliberately not built yet. */
  placeholder?: boolean;
};

export type NavGroup = {
  /** Shown as a quiet heading above the group; hidden when collapsed. */
  label: string;
  items: readonly NavItem[];
};

/**
 * The sidebar, grouped.
 *
 * Grouping is the point: eight ungrouped links made the reader scan the whole
 * list to find anything. Four short groups let someone jump to the right
 * region first — the same reason a business dashboard separates "what
 * happened" from "what I administer".
 *
 * Order within a group runs most-used first, not alphabetically.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        title: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
        description: "Overview of streamer performance across the roster.",
        permission: "dashboard.view",
      },
    ],
  },
  {
    label: "Content",
    items: [
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
    ],
  },
  {
    label: "Management",
    items: [
      {
        title: "Streamers",
        href: "/streamers",
        icon: Users,
        description: "Roster of connected Facebook Pages and their metrics.",
        permission: "streamers.view",
      },
      {
        title: "Campaign reports",
        href: "/reports",
        icon: BarChart3,
        description: "Period reports and Google Sheets exports.",
        permission: "reports.view",
      },
      {
        title: "Sync history",
        href: "/admin/sync-logs",
        icon: History,
        description: "Every synchronisation run and what it produced.",
        permission: "sync.view_errors",
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        title: "User management",
        href: "/admin/users",
        icon: Users,
        description: "Accounts, roles and the audit trail behind role changes.",
        permission: "users.manage",
      },
      {
        title: "Facebook API",
        href: "/admin/facebook-api",
        icon: Plug,
        description: "Meta app configuration and Page token health.",
        permission: "settings.manage",
        placeholder: true,
      },
      {
        title: "AI settings",
        href: "/admin/ai",
        icon: Bot,
        description: "Comment summarisation provider, model and limits.",
        permission: "settings.manage",
        placeholder: true,
      },
      {
        title: "n8n integration",
        href: "/admin/n8n",
        icon: Share2,
        description: "Automation endpoints and the workflow that calls them.",
        permission: "settings.manage",
        placeholder: true,
      },
      {
        title: "Google Sheets",
        href: "/admin/google-sheets",
        icon: Table2,
        description: "Export tabs, match columns and recent export runs.",
        permission: "settings.manage",
        placeholder: true,
      },
      {
        title: "General settings",
        href: "/admin/general",
        icon: Sliders,
        description: "Sync frequency, batch sizes and workspace defaults.",
        permission: "settings.manage",
        placeholder: true,
      },
    ],
  },
] as const;

/**
 * Pinned to the bottom, away from the navigation proper.
 *
 * Help belongs here rather than in a group because it is not somewhere you are
 * working towards — it is what you reach for when stuck, and it should be
 * findable without reading the list.
 */
export const FOOTER_NAV: readonly NavItem[] = [
  {
    title: "Help and documentation",
    href: "/help",
    icon: BookOpen,
    description: "Setup guides, troubleshooting and secret rotation.",
    permission: "dashboard.view",
    placeholder: true,
  },
  {
    title: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Workspace configuration and integration status.",
    permission: "dashboard.view",
  },
] as const;

/**
 * Flat list, for anything resolving a path to a title — breadcrumbs and the
 * header both do. Derived rather than restated so it cannot drift from the
 * grouped structure above.
 */
export const mainNav: readonly NavItem[] = [
  ...NAV_GROUPS.flatMap((group) => group.items),
  ...FOOTER_NAV,
];

/**
 * The nav entry whose href best matches a pathname.
 *
 * Longest match wins, so `/admin/sync-logs` resolves to Sync history rather
 * than to whatever shorter prefix also matched.
 */
export function findNavItem(pathname: string): NavItem | undefined {
  return mainNav
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
