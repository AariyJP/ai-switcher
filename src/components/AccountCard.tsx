import { useState, useRef, useEffect } from "react";
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  RefreshCw,
  RotateCcw,
  Trash2,
  Zap,
} from "lucide-react";
import type { AccountWithUsage } from "@/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { UsageBar } from "@/components/UsageBar";

interface AccountCardProps {
  account: AccountWithUsage;
  onSwitch: () => void;
  onWarmup: () => Promise<void>;
  onDelete: () => void;
  onRefresh: () => Promise<unknown>;
  onRename: (newName: string) => Promise<void>;
  switching?: boolean;
  switchDisabled?: boolean;
  warmingUp?: boolean;
  masked?: boolean;
  usageEnabled?: boolean;
  warmupEnabled?: boolean;
  switchDisabledLabel?: string;
  switchDisabledTooltip?: string;
  onToggleMask?: () => void;
  autoWarmupEnabled?: boolean;
  autoWarmupManagedByAll?: boolean;
  autoWarmupLabel?: string;
  onToggleAutoWarmup?: () => void;
  onUseRateLimitReset?: () => Promise<unknown>;
}

function formatLastRefresh(date: Date | null): string {
  if (!date) return "Never";
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 5) return "Just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return date.toLocaleDateString();
}

// Subscription status uses semantic tokens: destructive (expired/<=3d), warning (<=7d), muted (else).
function getSubscriptionStatus(timestamp: string | null | undefined): {
  label: string;
  className: string;
} {
  if (!timestamp) {
    return {
      label: "Expiry unavailable",
      className: "text-muted-foreground",
    };
  }

  const expiryDate = new Date(timestamp);
  const formattedDate = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(expiryDate);

  const remainingMs = expiryDate.getTime() - Date.now();
  if (remainingMs <= 0) {
    return {
      label: `Expired ${formattedDate}`,
      className: "text-destructive",
    };
  }
  if (remainingMs <= 3 * 24 * 60 * 60 * 1000) {
    return {
      label: `Until ${formattedDate}`,
      className: "text-destructive",
    };
  }
  if (remainingMs <= 7 * 24 * 60 * 60 * 1000) {
    return {
      label: `Until ${formattedDate}`,
      className: "text-warning",
    };
  }
  return {
    label: `Until ${formattedDate}`,
    className: "text-muted-foreground",
  };
}

function formatResetCreditExpiry(timestamp: string): string {
  const expiryDate = new Date(timestamp);
  if (Number.isNaN(expiryDate.getTime())) return "Expiry unavailable";

  const exact = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(expiryDate);
  const remainingMs = expiryDate.getTime() - Date.now();
  if (remainingMs <= 0) return `Expired ${exact}`;
  const remainingHours = Math.floor(remainingMs / (60 * 60 * 1000));
  if (remainingHours < 24) return `Expires in ${remainingHours}h (${exact})`;
  const remainingDays = Math.floor(remainingHours / 24);
  return `Expires in ${remainingDays}d (${exact})`;
}

function BlurredText({ children, blur }: { children: React.ReactNode; blur: boolean }) {
  return (
    <span className={cn("transition-all duration-200", blur && "select-none blur-sm")}>
      {children}
    </span>
  );
}

type PlanBadgeVariant = "default" | "secondary" | "outline" | "success" | "warning";

function getPlanBadgeVariant(planKey: string): PlanBadgeVariant {
  switch (planKey) {
    case "pro":
      return "default";
    case "plus":
      return "success";
    case "team":
      return "secondary";
    case "enterprise":
      return "warning";
    case "api_key":
      return "secondary";
    case "free":
    default:
      return "outline";
  }
}

function ActiveDot() {
  return (
    <span className="relative flex size-2">
      <span className="bg-success/75 absolute inline-flex size-2 animate-ping rounded-full" />
      <span className="bg-success relative inline-flex size-2 rounded-full" />
    </span>
  );
}

export function AccountCard({
  account,
  onSwitch,
  onWarmup,
  onDelete,
  onRefresh,
  onRename,
  switching,
  switchDisabled,
  warmingUp,
  masked = false,
  usageEnabled = true,
  warmupEnabled = true,
  switchDisabledLabel = "Codex Running",
  switchDisabledTooltip = "Close all Codex processes first",
  onToggleMask,
  autoWarmupEnabled = false,
  autoWarmupManagedByAll = false,
  autoWarmupLabel,
  onToggleAutoWarmup,
  onUseRateLimitReset,
}: AccountCardProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetDetailsOpen, setIsResetDetailsOpen] = useState(false);
  const [isUsingReset, setIsUsingReset] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(
    account.usage && !account.usage.error ? new Date() : null
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
      setLastRefresh(new Date());
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleUseRateLimitReset = async () => {
    if (!onUseRateLimitReset) return;
    setIsUsingReset(true);
    try {
      await onUseRateLimitReset();
      setLastRefresh(new Date());
      setIsResetDialogOpen(false);
    } catch (err) {
      console.error("Failed to use rate limit reset:", err);
    } finally {
      setIsUsingReset(false);
    }
  };

  const handleRename = async () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== account.name) {
      try {
        await onRename(trimmed);
      } catch {
        setEditName(account.name);
      }
    } else {
      setEditName(account.name);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleRename();
    } else if (e.key === "Escape") {
      setEditName(account.name);
      setIsEditing(false);
    }
  };

  const normalizedPlanType = account.plan_type?.trim();
  const planKey = normalizedPlanType?.toLowerCase() || "api_key";
  const planDisplay = normalizedPlanType
    ? normalizedPlanType.charAt(0).toUpperCase() + normalizedPlanType.slice(1)
    : account.auth_mode === "api_key"
      ? "API Key"
      : null;

  const planBadgeVariant = getPlanBadgeVariant(planKey);
  const showPlanBadge =
    planDisplay !== null &&
    planKey !== "unknown" &&
    account.auth_mode !== "claude_desktop" &&
    !(account.auth_mode === "claude_code" && planKey === "code");
  const showSubscriptionStatus = usageEnabled && account.auth_mode === "chat_g_p_t";
  const subscriptionStatus = getSubscriptionStatus(account.subscription_expires_at);
  const resetCredits = account.usage?.rate_limit_reset_credits;
  const resetFetchError = account.usage?.rate_limit_reset_error;
  const resetAvailableCount =
    resetCredits?.available_count ?? account.usage?.rate_limit_reset_available_count ?? 0;
  const availableResetCredits = (resetCredits?.credits ?? [])
    .filter((credit) => credit.status === "available")
    .sort(
      (a, b) =>
        new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime()
    );
  const resetExpiryLabels =
    resetAvailableCount > 0
      ? Array.from({ length: resetAvailableCount }, (_, index) =>
          availableResetCredits[index]?.expires_at
            ? formatResetCreditExpiry(availableResetCredits[index].expires_at)
            : "Expiry unavailable"
        )
      : [];
  const showRateLimitReset =
    usageEnabled &&
    account.auth_mode === "chat_g_p_t" &&
    (resetCredits != null ||
      account.usage?.rate_limit_reset_available_count != null ||
      resetFetchError != null);
  const canUseRateLimitReset =
    !!onUseRateLimitReset && !resetFetchError && resetAvailableCount > 0 && !isUsingReset;
  const resetBadgeLabel = resetFetchError ? "Unavailable" : `${resetAvailableCount} available`;
  const resetButtonTooltip = resetFetchError
    ? "Usage reset status unavailable"
    : resetAvailableCount > 0
      ? "Use usage reset"
      : "No usage limit resets available";

  const cardClassName = cn(
    "relative gap-0 p-5 transition-all duration-200",
    account.is_active
      ? "border-success shadow-sm ring-2 ring-success/40"
      : "hover:ring-foreground/20"
  );

  return (
    <>
    <Card className={cardClassName}>
      <CardHeader className="mb-3 gap-3 p-0">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            {account.is_active && <ActiveDot />}
            {isEditing ? (
              <Input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleRename}
                onKeyDown={handleKeyDown}
                className="h-7 px-2 py-0.5 text-base font-semibold"
              />
            ) : (
              <h3
                className="text-foreground hover:text-muted-foreground cursor-pointer truncate font-semibold"
                onClick={() => {
                  if (masked) return;
                  setEditName(account.name);
                  setIsEditing(true);
                }}
                title={masked ? undefined : "Click to rename"}
              >
                <BlurredText blur={masked}>{account.name}</BlurredText>
              </h3>
            )}
          </div>
          {account.email && (
            <p className="text-muted-foreground truncate text-sm">
              <BlurredText blur={masked}>{account.email}</BlurredText>
            </p>
          )}
        </div>

        <CardAction className="flex items-center gap-2">
          {onToggleMask && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onToggleMask}
                  aria-label={masked ? "Show info" : "Hide info"}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {masked ? <EyeOff /> : <Eye />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{masked ? "Show info" : "Hide info"}</TooltipContent>
            </Tooltip>
          )}
          {showPlanBadge && (
            <Badge variant={planBadgeVariant} className="rounded-full px-2.5 py-1">
              {planDisplay}
            </Badge>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 p-0">
        {usageEnabled && (
          <UsageBar usage={account.usage} loading={isRefreshing || account.usageLoading} />
        )}

        {usageEnabled && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="text-muted-foreground">
              Last updated: {formatLastRefresh(lastRefresh)}
            </div>
            {showSubscriptionStatus && (
              <div className={cn("text-right", subscriptionStatus.className)}>
                {subscriptionStatus.label}
              </div>
            )}
          </div>
        )}

        {showRateLimitReset && (
          <button
            type="button"
            className={cn(
              "border-border/60 bg-muted/30 w-full rounded-md border p-3 text-left text-xs transition-colors",
              resetExpiryLabels.length > 0 && "cursor-pointer hover:bg-muted/50"
            )}
            aria-expanded={isResetDetailsOpen}
            disabled={resetExpiryLabels.length === 0}
            onClick={() => setIsResetDetailsOpen((open) => !open)}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-foreground shrink-0 font-medium">Usage resets</span>
              <Badge variant={!resetFetchError && resetAvailableCount > 0 ? "success" : "secondary"}>
                {resetBadgeLabel}
              </Badge>
              <span className="min-w-0 flex-1" />
              {resetExpiryLabels.length > 0 && (
                <ChevronDown
                  className={cn(
                    "text-muted-foreground size-4 shrink-0 transition-transform",
                    isResetDetailsOpen && "rotate-180"
                  )}
                />
              )}
            </div>
            {isResetDetailsOpen && resetExpiryLabels.length > 0 && (
              <ol className="text-muted-foreground mt-2 flex list-decimal flex-col gap-1 pl-4">
                {resetExpiryLabels.map((label, index) => (
                  <li key={`${label}-${index}`}>{label}</li>
                ))}
              </ol>
            )}
          </button>
        )}

        <div className="flex gap-2">
          {account.is_active ? (
            <Button disabled variant="secondary" className="flex-1">
              <Check data-icon="inline-start" /> Active
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onSwitch}
                  disabled={switching || switchDisabled}
                  className="flex-1"
                >
                  {switching ? "Switching..." : switchDisabled ? switchDisabledLabel : "Switch"}
                </Button>
              </TooltipTrigger>
              {switchDisabled && (
                <TooltipContent>{switchDisabledTooltip}</TooltipContent>
              )}
            </Tooltip>
          )}
          {usageEnabled && warmupEnabled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="warning"
                  size="icon"
                  onClick={() => {
                    void onWarmup();
                  }}
                  disabled={warmingUp}
                  aria-label={warmingUp ? "Sending warm-up request..." : "Send minimal warm-up request"}
                  className={cn(warmingUp && "animate-pulse")}
                >
                  <Zap />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {warmingUp ? "Sending warm-up request..." : "Send minimal warm-up request"}
              </TooltipContent>
            </Tooltip>
          )}
          {usageEnabled && warmupEnabled && onToggleAutoWarmup && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={autoWarmupEnabled ? "success" : "outline"}
                  onClick={onToggleAutoWarmup}
                  disabled={autoWarmupManagedByAll}
                  className="whitespace-nowrap"
                >
                  {autoWarmupLabel ?? `Auto: ${autoWarmupEnabled ? "on" : "off"}`}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {autoWarmupManagedByAll
                  ? "Auto warm-up is enabled for all accounts"
                  : autoWarmupEnabled
                    ? "Disable auto warm-up for this account"
                    : "Enable auto warm-up for this account"}
              </TooltipContent>
            </Tooltip>
          )}
          {usageEnabled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  aria-label="Refresh usage"
                >
                  <RefreshCw className={cn(isRefreshing && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh usage</TooltipContent>
            </Tooltip>
          )}
          {usageEnabled && account.auth_mode === "chat_g_p_t" && onUseRateLimitReset && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="destructive"
                  size="icon"
                  onClick={() => setIsResetDialogOpen(true)}
                  disabled={!canUseRateLimitReset}
                  aria-label="Use usage reset"
                >
                  <RotateCcw className={cn(isUsingReset && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {resetButtonTooltip}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="destructive" size="icon" onClick={onDelete} aria-label="Remove account">
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Remove account</TooltipContent>
          </Tooltip>
        </div>
      </CardContent>
    </Card>
    <AlertDialog open={isResetDialogOpen} onOpenChange={setIsResetDialogOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Use usage reset?</AlertDialogTitle>
          <AlertDialogDescription>
            This will reset your current Codex usage limits. You have{" "}
            {resetAvailableCount} usage limit{" "}
            {resetAvailableCount === 1 ? "reset" : "resets"} available.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {resetExpiryLabels.length > 0 && (
          <div className="text-muted-foreground text-sm">
            <div className="text-foreground mb-2 font-medium">Available resets</div>
            <ol className="flex list-decimal flex-col gap-1 pl-5">
              {resetExpiryLabels.map((label, index) => (
                <li key={`${label}-dialog-${index}`}>{label}</li>
              ))}
            </ol>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isUsingReset}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!canUseRateLimitReset}
            onClick={(event) => {
              event.preventDefault();
              void handleUseRateLimitReset();
            }}
          >
            {isUsingReset ? "Using..." : "Use reset"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
