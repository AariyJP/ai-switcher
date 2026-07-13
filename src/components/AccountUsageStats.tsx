import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, ChevronDown, RefreshCw } from "lucide-react";
import type {
  AccountDailyUsage,
  AccountTopInvocation,
  AccountUsageStats as AccountUsageStatsInfo,
} from "@/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { invokeBackend } from "@/lib/platform";
import { cn } from "@/lib/utils";

const PROFILE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface AccountUsageStatsProps {
  accountId: string;
  enabled: boolean;
  defaultOpen?: boolean;
  onStatsLoaded?: (stats: AccountUsageStatsInfo | null) => void;
}

function emptyStats(accountId: string, error: string): AccountUsageStatsInfo {
  return {
    account_id: accountId,
    available: false,
    source: "Codex usage stats via ChatGPT backend",
    generated_at: null,
    stats_as_of: null,
    summary: {
      lifetime_tokens: null,
      peak_daily_tokens: null,
      longest_task_seconds: null,
      current_streak_days: null,
      longest_streak_days: null,
    },
    activity: {
      fast_mode_percent: null,
      reasoning_effort: null,
      reasoning_effort_percent: null,
      skills_explored: null,
      total_skills_used: null,
      total_threads: null,
    },
    daily: [],
    top_invocations: [],
    reset_credits: null,
    error,
  };
}

function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return "--";
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat().format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${Math.round(value)}%`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "--";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatDateLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric" }).format(parsed);
}

function formatGeneratedAt(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  return new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric" }).format(date);
}

function dayKey(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sumDays(daily: AccountDailyUsage[], days: number): number {
  const keys = new Set(Array.from({ length: days }, (_, index) => dayKey(index)));
  return daily.reduce((total, day) => (keys.has(day.date) ? total + day.tokens : total), 0);
}

type ActivityRange = 30 | 90 | 180 | "all";

const ACTIVITY_RANGE_OPTIONS: { value: ActivityRange; label: string }[] = [
  { value: 30, label: "30d" },
  { value: 90, label: "3 mo" },
  { value: 180, label: "6 mo" },
  { value: "all", label: "All" },
];

function activityRangeDays(range: ActivityRange, daily: AccountDailyUsage[]): number {
  if (range !== "all") return range;
  return Math.max(30, daily.length);
}

function activityRangeLabel(range: ActivityRange): string {
  switch (range) {
    case 30:
      return "Last 30 days";
    case 90:
      return "Last 3 months";
    case 180:
      return "Last 6 months";
    case "all":
      return "All reported";
  }
}

function recentDailyBars(daily: AccountDailyUsage[], range: ActivityRange): AccountDailyUsage[] {
  if (range === "all") {
    return [...daily].sort((a, b) => a.date.localeCompare(b.date));
  }

  const byDate = new Map(daily.map((day) => [day.date, day.tokens]));
  return Array.from({ length: range }, (_, index) => {
    const date = dayKey(range - index - 1);
    return { date, tokens: byDate.get(date) ?? 0 };
  });
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-border bg-muted/30 min-w-0 rounded-lg border px-3 py-2">
      <div className="text-muted-foreground truncate text-[11px] font-medium">
        {label}
      </div>
      <div className="text-foreground mt-1 truncate text-sm font-semibold">
        {value}
      </div>
      {sub && (
        <div className="text-muted-foreground mt-0.5 truncate text-[11px]">
          {sub}
        </div>
      )}
    </div>
  );
}

function TokenActivity({ daily }: { daily: AccountDailyUsage[] }) {
  const [range, setRange] = useState<ActivityRange>(30);
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const bars = useMemo(() => recentDailyBars(daily, range), [daily, range]);
  const rangeDays = activityRangeDays(range, daily);
  const maxTokens = Math.max(1, ...bars.map((day) => day.tokens));

  if (bars.length === 0 || !bars.some((day) => day.tokens > 0)) {
    return (
      <div className="border-border text-muted-foreground flex h-14 items-center justify-center rounded-lg border border-dashed text-[11px]">
        Daily activity unavailable
      </div>
    );
  }

  return (
    <div className="border-border bg-background rounded-lg border px-3 pt-2 pb-3">
      <div className="mb-2 flex items-center justify-between text-[11px]">
        <span className="text-foreground font-medium">Token activity</span>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{activityRangeLabel(range)}</span>
          <Select
            value={String(range)}
            onValueChange={(value) => {
              setRange(value === "all" ? "all" : (Number(value) as ActivityRange));
            }}
          >
            <SelectTrigger
              size="sm"
              className="h-6 px-2 text-[11px]"
              aria-label="Token activity range"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIVITY_RANGE_OPTIONS.map((option) => (
                <SelectItem key={option.label} value={String(option.value)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div
        className="relative grid h-14 grid-flow-col auto-cols-fr items-end gap-px sm:gap-1"
        onMouseLeave={() => setHoveredDate(null)}
      >
        {bars.map((day) => {
          const height = day.tokens > 0 ? Math.max(8, Math.round((day.tokens / maxTokens) * 52)) : 3;
          const isEmpty = day.tokens === 0;
          const maxWidth = rangeDays > 90 ? "max-w-1.5" : rangeDays > 45 ? "max-w-2" : "max-w-3";
          const isHovered = hoveredDate === day.date;
          return (
            <div
              key={day.date}
              className="relative flex h-14 items-end justify-center"
              onMouseEnter={() => setHoveredDate(day.date)}
            >
              {isHovered && (
                <div className="bg-popover text-popover-foreground ring-foreground/10 pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 min-w-max -translate-x-1/2 rounded-md px-2 py-1 text-[11px] shadow-lg ring-1">
                  {formatDateLabel(day.date)} · {formatTokens(day.tokens)}
                </div>
              )}
              <div
                className={cn(
                  "w-full rounded-t transition-colors",
                  maxWidth,
                  isEmpty ? "bg-muted" : "bg-primary hover:bg-primary/80"
                )}
                style={{ height }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DetailPanel({
  activity,
  thirtyDayTokens,
  summary,
  topInvocations,
}: {
  activity: AccountUsageStatsInfo["activity"];
  thirtyDayTokens: number | null;
  summary: AccountUsageStatsInfo["summary"];
  topInvocations: AccountTopInvocation[];
}) {
  const hasActivity =
    activity.fast_mode_percent !== null ||
    activity.reasoning_effort !== null ||
    activity.skills_explored !== null ||
    activity.total_threads !== null;
  const [open, setOpen] = useState(false);

  return (
    <div className="border-border bg-muted/30 rounded-lg border transition-colors">
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-between rounded-lg px-3 py-2 text-[12px] font-semibold"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        More usage details
        <ChevronDown
          className={cn(
            "text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </Button>
      {open && (
        <div className="border-border grid gap-3 border-t p-3 sm:grid-cols-2">
          <div className="grid grid-cols-3 gap-2 sm:col-span-2">
            <StatTile
              label="Last 30 days"
              value={formatTokens(thirtyDayTokens)}
              sub="reported"
            />
            <StatTile
              label="Longest task"
              value={formatDuration(summary.longest_task_seconds)}
            />
            <StatTile
              label="Longest streak"
              value={`${formatNumber(summary.longest_streak_days)} days`}
            />
          </div>

          {hasActivity && (
            <div className="space-y-1.5">
              <div className="text-foreground mb-1 text-[11px] font-semibold">
                Activity insights
              </div>
              <div className="flex justify-between gap-2 text-[11px]">
                <span className="text-muted-foreground">Fast mode</span>
                <span className="text-foreground">
                  {formatPercent(activity.fast_mode_percent)}
                </span>
              </div>
              <div className="flex justify-between gap-2 text-[11px]">
                <span className="text-muted-foreground">Reasoning</span>
                <span className="text-foreground">
                  {activity.reasoning_effort ?? "--"}
                  {activity.reasoning_effort_percent !== null &&
                    ` · ${formatPercent(activity.reasoning_effort_percent)}`}
                </span>
              </div>
              <div className="flex justify-between gap-2 text-[11px]">
                <span className="text-muted-foreground">Skills explored</span>
                <span className="text-foreground">
                  {formatNumber(activity.skills_explored)}
                </span>
              </div>
              <div className="flex justify-between gap-2 text-[11px]">
                <span className="text-muted-foreground">Total threads</span>
                <span className="text-foreground">
                  {formatNumber(activity.total_threads)}
                </span>
              </div>
            </div>
          )}

          {topInvocations.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-foreground mb-1 text-[11px] font-semibold">
                Most used plugins
              </div>
              {topInvocations.slice(0, 5).map((invocation) => (
                <InvocationRow
                  key={`${invocation.kind}-${invocation.display_name}-${invocation.usage_count}`}
                  invocation={invocation}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InvocationRow({ invocation }: { invocation: AccountTopInvocation }) {
  const prefix = invocation.kind === "plugin" ? "@" : "$";
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-foreground min-w-0 truncate">
        {prefix}{invocation.display_name}
      </span>
      <span className="text-muted-foreground shrink-0">
        {formatNumber(invocation.usage_count)} runs
      </span>
    </div>
  );
}

export function AccountUsageStats({
  accountId,
  enabled,
  defaultOpen = false,
  onStatsLoaded,
}: AccountUsageStatsProps) {
  const [panelOpen, setPanelOpen] = useState(defaultOpen);
  const [stats, setStats] = useState<AccountUsageStatsInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const requestSeq = useRef(0);

  const loadStats = useCallback(async () => {
    const requestId = ++requestSeq.current;

    if (!enabled) {
      const next = emptyStats(accountId, "Usage stats are available for ChatGPT accounts only.");
      setStats(next);
      onStatsLoaded?.(next);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const next = await invokeBackend<AccountUsageStatsInfo>("get_account_usage_stats", {
        accountId,
      });
      if (requestId !== requestSeq.current) return;
      setStats(next);
      onStatsLoaded?.(next);
    } catch (err) {
      if (requestId !== requestSeq.current) return;
      const next = emptyStats(accountId, err instanceof Error ? err.message : String(err));
      setStats(next);
      onStatsLoaded?.(next);
    } finally {
      if (requestId === requestSeq.current) {
        setLoading(false);
      }
    }
  }, [accountId, enabled, onStatsLoaded]);

  useEffect(() => {
    requestSeq.current += 1;
    setStats(null);
    onStatsLoaded?.(null);
    setLoading(false);
    setPanelOpen(defaultOpen);
  }, [accountId, defaultOpen, onStatsLoaded]);

  useEffect(() => {
    if (!panelOpen) return;
    void loadStats();
  }, [loadStats, panelOpen]);

  useEffect(() => {
    if (!enabled || !panelOpen) return;
    const timer = window.setInterval(() => {
      void loadStats();
    }, PROFILE_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, loadStats, panelOpen]);

  const currentStats = stats?.account_id === accountId ? stats : null;
  const generatedAt = currentStats ? formatGeneratedAt(currentStats.generated_at) : "";
  const todayTokens = currentStats ? sumDays(currentStats.daily, 1) : null;
  const sevenDayTokens = currentStats ? sumDays(currentStats.daily, 7) : null;
  const thirtyDayTokens = currentStats ? sumDays(currentStats.daily, 30) : null;

  return (
    <div className="border-border border-t pt-3">
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-between gap-3 px-1 py-1 text-sm font-semibold"
        onClick={() => setPanelOpen((value) => !value)}
        aria-expanded={panelOpen}
      >
        <span className="flex min-w-0 items-center gap-2">
          <BarChart3 className="text-muted-foreground" />
          <span className="truncate">Usage Stats</span>
          {generatedAt && (
            <span className="text-muted-foreground truncate text-[11px] font-normal">
              updated {generatedAt}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "text-muted-foreground transition-transform",
            panelOpen && "rotate-180"
          )}
        />
      </Button>

      {panelOpen && (
        <div className="pt-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-muted-foreground truncate text-[11px]">
              {currentStats?.stats_as_of
                ? `Stats as of ${currentStats.stats_as_of}`
                : currentStats?.source ?? "ChatGPT backend"}
              {generatedAt && ` · updated ${generatedAt}`}
            </p>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void loadStats()}
              disabled={loading || !enabled}
              title="Refresh usage stats"
            >
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </div>

          {loading && !currentStats ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[0, 1, 2, 3, 4].map((item) => (
                <Skeleton key={item} className="h-16 rounded-lg" />
              ))}
            </div>
          ) : currentStats?.available ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <StatTile
                  label="Lifetime"
                  value={formatTokens(currentStats.summary.lifetime_tokens)}
                  sub="tokens"
                />
                <StatTile label="Today" value={formatTokens(todayTokens)} sub="reported" />
                <StatTile
                  label="Last 7 days"
                  value={formatTokens(sevenDayTokens)}
                  sub="reported"
                />
                <StatTile
                  label="Current streak"
                  value={`${formatNumber(currentStats.summary.current_streak_days)} days`}
                />
                <StatTile
                  label="Peak day"
                  value={formatTokens(currentStats.summary.peak_daily_tokens)}
                  sub="tokens"
                />
              </div>

              <TokenActivity daily={currentStats.daily} />

              <DetailPanel
                activity={currentStats.activity}
                thirtyDayTokens={thirtyDayTokens}
                summary={currentStats.summary}
                topInvocations={currentStats.top_invocations}
              />
            </div>
          ) : (
            <Alert variant="warning">
              <AlertDescription>
                {currentStats?.error ?? "Usage stats unavailable."}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}
