import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { UsageInfo } from "@/types";

interface UsageBarProps {
  usage?: UsageInfo;
  loading?: boolean;
}

function formatResetTime(resetAt: number | null | undefined): string {
  if (!resetAt) return "";
  const now = Math.floor(Date.now() / 1000);
  const diff = resetAt - now;
  if (diff <= 0) return "now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
}

function formatExactResetTime(resetAt: number | null | undefined): string {
  if (!resetAt) return "";

  const date = new Date(resetAt * 1000);
  const month = new Intl.DateTimeFormat(undefined, { month: "long" }).format(date);
  const day = date.getDate();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const period = date.getHours() >= 12 ? "PM" : "AM";
  const hour12 = date.getHours() % 12 || 12;

  return `${month} ${day}, ${hour12}:${minutes} ${period}`;
}

function formatWindowDuration(minutes: number | null | undefined): string {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function RateLimitBar({
  label,
  usedPercent,
  windowMinutes,
  resetsAt,
  slim = false,
}: {
  label: string;
  usedPercent: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
  slim?: boolean;
}) {
  const remainingPercent = Math.max(0, 100 - usedPercent);
  // Semantic status color: low remaining → destructive → warning → success
  const indicatorClass =
    remainingPercent <= 10
      ? "bg-destructive"
      : remainingPercent <= 30
        ? "bg-warning"
        : "bg-success";

  const windowLabel = formatWindowDuration(windowMinutes);
  const resetLabel = formatResetTime(resetsAt);
  const exactResetLabel = formatExactResetTime(resetsAt);

  return (
    <div className="flex flex-col gap-1">
      <div className="text-muted-foreground flex justify-between text-xs">
        <span>
          {label} {windowLabel && `(${windowLabel})`}
        </span>
        <span>
          {remainingPercent.toFixed(0)}% left
          {resetLabel && ` • resets ${resetLabel}`}
          {resetLabel && exactResetLabel && ` (${exactResetLabel})`}
        </span>
      </div>
      <Progress
        value={remainingPercent}
        className={slim ? "h-0.5" : "h-1.5"}
        indicatorClassName={cn("transition-all duration-300", indicatorClass)}
      />
    </div>
  );
}

export function UsageBar({ usage, loading }: UsageBarProps) {
  if (loading && !usage) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-1.5 w-full" />
      </div>
    );
  }

  if (!usage) {
    return <Skeleton className="h-3 w-24" />;
  }

  if (usage.error) {
    return (
      <div className="text-muted-foreground py-1 text-xs italic">{usage.error}</div>
    );
  }

  const cursorUsage = usage.cursor_usage;
  if (cursorUsage) {
    const totalUsedPercent = cursorUsage.total_used_percent;
    const autoUsedPercent = cursorUsage.auto_composer_used_percent;
    const apiUsedPercent = cursorUsage.api_used_percent;

    if (
      totalUsedPercent == null &&
      autoUsedPercent == null &&
      apiUsedPercent == null
    ) {
      return (
        <div className="text-muted-foreground py-1 text-xs italic">No usage data</div>
      );
    }

    return (
      <div className="flex flex-col gap-2">
        {totalUsedPercent != null && (
          <RateLimitBar
            label="Total"
            usedPercent={totalUsedPercent}
            windowMinutes={usage.primary_window_minutes}
            resetsAt={usage.primary_resets_at}
          />
        )}
        {autoUsedPercent != null && (
          <RateLimitBar label="Auto + Composer" usedPercent={autoUsedPercent} slim />
        )}
        {apiUsedPercent != null && (
          <RateLimitBar label="API" usedPercent={apiUsedPercent} slim />
        )}
      </div>
    );
  }

  const hasPrimary =
    usage.primary_used_percent !== null && usage.primary_used_percent !== undefined;
  const hasSecondary =
    usage.secondary_used_percent !== null && usage.secondary_used_percent !== undefined;
  const scopedLimits = (usage.scoped_limits ?? []).filter((limit) => !!limit.label);
  const hasScoped = scopedLimits.length > 0;

  if (!hasPrimary && !hasSecondary && !hasScoped) {
    return (
      <div className="text-muted-foreground py-1 text-xs italic">No rate limit data</div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {hasPrimary && (
        <RateLimitBar
          label="5h Limit"
          usedPercent={usage.primary_used_percent!}
          windowMinutes={usage.primary_window_minutes}
          resetsAt={usage.primary_resets_at}
        />
      )}
      {hasSecondary && (
        <RateLimitBar
          label="Weekly Limit"
          usedPercent={usage.secondary_used_percent!}
          windowMinutes={usage.secondary_window_minutes}
          resetsAt={usage.secondary_resets_at}
        />
      )}
      {scopedLimits.map((limit, index) => (
        <RateLimitBar
          key={limit.label ?? index}
          label={`Weekly Limit · ${limit.label}`}
          usedPercent={limit.used_percent}
          windowMinutes={limit.window_minutes}
          resetsAt={limit.resets_at}
          slim
        />
      ))}
      {usage.credits_balance && (
        <div className="text-muted-foreground text-xs">Credits: {usage.credits_balance}</div>
      )}
    </div>
  );
}
