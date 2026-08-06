"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { SentimentSlice, TimeSeriesPoint, TopStreamer } from "@/lib/ui/dashboard-shapes";
import { describeStatus } from "@/lib/ui/status";

/**
 * The dashboard's charts.
 *
 * Four, not eight. Every metric in its own chart is a wall of panels that
 * answers no question; these each answer one — how engagement moved, what the
 * mix of publishing was, who is carrying the roster, and how audiences feel.
 *
 * Colours come from the chart tokens rather than Recharts' defaults, so the
 * series match the rest of the product and follow the theme into dark mode.
 * Referencing a CSS variable keeps that automatic: Recharts is handed
 * `var(--chart-1)`, not a resolved hex, so a theme switch repaints without a
 * re-render.
 */

const AXIS = {
  stroke: "var(--muted-foreground)",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

/** Shared tooltip styling. Recharts wants inline style objects here. */
const TOOLTIP_STYLE = {
  contentStyle: {
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    fontSize: "12px",
    color: "var(--popover-foreground)",
  },
  labelStyle: { color: "var(--muted-foreground)", marginBottom: 2 },
} as const;

function shortDay(day: string): string {
  // "2026-07-14" → "14 Jul". Parsed as UTC to match how the day was bucketed.
  const date = new Date(`${day}T00:00:00Z`);
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * Engagement over time.
 *
 * Posts only — videos do not carry comparable engagement columns, and the
 * caller says so beneath the chart rather than letting the reader assume the
 * line covers everything.
 */
export function EngagementChart({ data }: { data: TimeSeriesPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="day" tickFormatter={shortDay} {...AXIS} minTickGap={24} />
        <YAxis {...AXIS} width={44} allowDecimals={false} />
        <Tooltip {...TOOLTIP_STYLE} labelFormatter={(label) => shortDay(String(label))} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          dataKey="reactions"
          name="Reactions"
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="comments"
          name="Comments"
          stroke="var(--chart-2)"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="shares"
          name="Shares"
          stroke="var(--chart-3)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Publishing volume: posts against videos, stacked because it is a mix. */
export function VolumeChart({ data }: { data: TimeSeriesPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="day" tickFormatter={shortDay} {...AXIS} minTickGap={24} />
        <YAxis {...AXIS} width={44} allowDecimals={false} />
        <Tooltip
          {...TOOLTIP_STYLE}
          labelFormatter={(label) => shortDay(String(label))}
          cursor={{ fill: "var(--muted)" }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar
          dataKey="postCount"
          name="Posts"
          stackId="v"
          fill="var(--chart-1)"
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="videoCount"
          name="Videos"
          stackId="v"
          fill="var(--chart-4)"
          radius={[3, 3, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Top streamers by total engagement. Horizontal, so long names stay readable. */
export function TopStreamersChart({ data }: { data: TopStreamer[] }) {
  const rows = data.map((row) => ({
    name: row.streamerName,
    total: row.reactions + row.comments + row.shares,
  }));

  return (
    <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 38)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" {...AXIS} allowDecimals={false} />
        {/*
         * A generous width and truncation, because a streamer name can be long
         * and a clipped label is worse than an elided one.
         */}
        <YAxis
          type="category"
          dataKey="name"
          {...AXIS}
          width={110}
          tickFormatter={(value: string) => (value.length > 16 ? `${value.slice(0, 15)}…` : value)}
        />
        <Tooltip {...TOOLTIP_STYLE} cursor={{ fill: "var(--muted)" }} />
        <Bar dataKey="total" name="Engagement" fill="var(--chart-1)" radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Sentiment distribution.
 *
 * Labelled in the legend as well as coloured, so the split is readable without
 * relying on hue — the same rule the status badges follow.
 */
const SENTIMENT_FILL: Record<string, string> = {
  positive: "var(--sentiment-positive)",
  mixed: "var(--sentiment-mixed)",
  neutral: "var(--sentiment-neutral)",
  negative: "var(--sentiment-negative)",
  no_comments: "var(--sentiment-none)",
};

export function SentimentChart({ data }: { data: SentimentSlice[] }) {
  const rows = data.map((slice) => ({
    key: slice.sentiment,
    name: describeStatus("sentiment", slice.sentiment).label,
    value: slice.count,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={rows}
          dataKey="value"
          nameKey="name"
          innerRadius={52}
          outerRadius={78}
          paddingAngle={2}
          stroke="var(--card)"
        >
          {rows.map((row) => (
            <Cell key={row.key} fill={SENTIMENT_FILL[row.key] ?? "var(--sentiment-none)"} />
          ))}
        </Pie>
        <Tooltip {...TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

/**
 * Followers over time.
 *
 * A line rather than bars: the running total is a level, and bars imply a
 * quantity added each day — which is what `newFollows` means and this is not.
 *
 * `domain={["dataMin", "dataMax"]}` because a Page with forty thousand
 * followers gaining two hundred is a real week's work, and an axis anchored at
 * zero renders that as a flat line. The trade-off is that a small change looks
 * dramatic, which is why the card beside it states the actual number.
 */
export function FollowerChart({
  data,
}: {
  data: { date: string; followers: number | null }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDay} {...AXIS} minTickGap={24} />
        <YAxis {...AXIS} width={56} domain={["dataMin", "dataMax"]} allowDecimals={false} />
        <Tooltip {...TOOLTIP_STYLE} labelFormatter={(label) => shortDay(String(label))} />
        <Line
          type="monotone"
          dataKey="followers"
          name="Followers"
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={false}
          // A day Meta did not report leaves a gap rather than a line drawn
          // straight through it, which would invent a measurement.
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** New follows per day. Bars, because each one is a quantity gained. */
export function NewFollowsChart({
  data,
}: {
  data: { date: string; newFollows: number | null }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDay} {...AXIS} minTickGap={24} />
        <YAxis {...AXIS} width={44} allowDecimals={false} />
        <Tooltip {...TOOLTIP_STYLE} labelFormatter={(label) => shortDay(String(label))} />
        <Bar dataKey="newFollows" name="New follows" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
