import { useState, useRef, useEffect } from "react";
import { Check, Eye, EyeOff, LogOut, RefreshCw, Trash2, Zap } from "lucide-react";
import type { AccountWithUsage } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { UsageBar } from "./UsageBar";

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
  isLogoutCard?: boolean;
  autoWarmupEnabled?: boolean;
  autoWarmupManagedByAll?: boolean;
  autoWarmupLabel?: string;
  onToggleAutoWarmup?: () => void;
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
      className: "text-red-500 dark:text-red-400",
    };
  }
  if (remainingMs <= 3 * 24 * 60 * 60 * 1000) {
    return {
      label: `Until ${formattedDate}`,
      className: "text-red-500 dark:text-red-400",
    };
  }
  if (remainingMs <= 7 * 24 * 60 * 60 * 1000) {
    return {
      label: `Until ${formattedDate}`,
      className: "text-amber-500 dark:text-amber-400",
    };
  }
  return {
    label: `Until ${formattedDate}`,
    className: "text-muted-foreground",
  };
}

function BlurredText({ children, blur }: { children: React.ReactNode; blur: boolean }) {
  return (
    <span
      className={cn("select-none transition-all duration-200", blur && "blur-sm")}
      style={blur ? { userSelect: "none" } : undefined}
    >
      {children}
    </span>
  );
}

const planVariantMap: Record<
  string,
  { className: string }
> = {
  pro: {
    className:
      "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  },
  plus: {
    className:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  },
  team: {
    className:
      "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  },
  enterprise: {
    className:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  },
  free: {
    className:
      "border-border bg-muted text-muted-foreground",
  },
  api_key: {
    className:
      "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  },
};

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
  isLogoutCard = false,
  autoWarmupEnabled = false,
  autoWarmupManagedByAll = false,
  autoWarmupLabel,
  onToggleAutoWarmup,
}: AccountCardProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
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

  const planVariant = planVariantMap[planKey] ?? planVariantMap.free;
  const showPlanBadge =
    planDisplay !== null &&
    planKey !== "unknown" &&
    account.auth_mode !== "claude_desktop" &&
    !(account.auth_mode === "claude_code" && planKey === "code");
  const usageUnsupportedMessage =
    account.auth_mode === "claude_desktop"
      ? "Usage is currently not supported for Claude Desktop accounts."
      : null;
  const showSubscriptionStatus = usageEnabled && account.auth_mode === "chat_g_p_t";
  const subscriptionStatus = getSubscriptionStatus(account.subscription_expires_at);

  if (isLogoutCard) {
    return (
      <Card
        className={cn(
          "relative gap-0 p-5 transition-all duration-200",
          account.is_active
            ? "border-emerald-400 shadow-sm"
            : "hover:border-foreground/20"
        )}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              {account.is_active && (
                <span className="relative flex h-2 w-2">
                  <span className="bg-emerald-400/75 absolute inline-flex h-2 w-2 animate-ping rounded-full" />
                  <span className="bg-emerald-500 relative inline-flex h-2 w-2 rounded-full" />
                </span>
              )}
              <h3 className="text-foreground truncate font-semibold">Logout</h3>
            </div>
            <p className="text-muted-foreground truncate text-sm">
              Clear the current Claude Desktop login without revoking saved
              accounts. Open Claude Desktop afterwards to sign in with a new
              account.
            </p>
          </div>
          <Badge variant="outline" className="rounded-full px-2.5 py-1">
            <LogOut className="mr-1 size-3" /> Signed out
          </Badge>
        </div>

        <div className="flex gap-2">
          {account.is_active ? (
            <Button disabled variant="secondary" className="flex-1">
              <Check className="size-4" /> Logged out
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onSwitch}
                  disabled={switching || switchDisabled}
                  className="flex-1"
                >
                  {switching
                    ? "Logging out..."
                    : switchDisabled
                      ? switchDisabledLabel
                      : "Logout"}
                </Button>
              </TooltipTrigger>
              {switchDisabled && (
                <TooltipContent>{switchDisabledTooltip}</TooltipContent>
              )}
            </Tooltip>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card
      className={cn(
        "relative gap-0 p-5 transition-all duration-200",
        account.is_active
          ? "border-emerald-400 shadow-sm"
          : "hover:border-foreground/20"
      )}
    >
      <div className="mb-3 flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            {account.is_active && (
              <span className="relative flex h-2 w-2">
                <span className="bg-emerald-400/75 absolute inline-flex h-2 w-2 animate-ping rounded-full" />
                <span className="bg-emerald-500 relative inline-flex h-2 w-2 rounded-full" />
              </span>
            )}
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

        <div className="flex items-center gap-2">
          {onToggleMask && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onToggleMask}
                  className="text-muted-foreground hover:text-foreground h-7 w-7"
                >
                  {masked ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{masked ? "Show info" : "Hide info"}</TooltipContent>
            </Tooltip>
          )}
          {showPlanBadge && (
            <Badge
              variant="outline"
              className={cn("rounded-full px-2.5 py-1", planVariant.className)}
            >
              {planDisplay}
            </Badge>
          )}
        </div>
      </div>

      {usageUnsupportedMessage && (
        <div className="text-muted-foreground mb-3 rounded-md border px-3 py-2 text-sm italic">
          {usageUnsupportedMessage}
        </div>
      )}

      {usageEnabled && !usageUnsupportedMessage && (
        <div className="mb-3">
          <UsageBar usage={account.usage} loading={isRefreshing || account.usageLoading} />
        </div>
      )}

      {usageEnabled && !usageUnsupportedMessage && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
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

      <div className="flex gap-2">
        {account.is_active ? (
          <Button disabled variant="secondary" className="flex-1">
            <Check className="size-4" /> Active
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
        {usageEnabled && !usageUnsupportedMessage && warmupEnabled && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  void onWarmup();
                }}
                disabled={warmingUp}
                className={cn(
                  "border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30",
                  warmingUp && "animate-pulse"
                )}
              >
                <Zap className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {warmingUp ? "Sending warm-up request..." : "Send minimal warm-up request"}
            </TooltipContent>
          </Tooltip>
        )}
        {usageEnabled && !usageUnsupportedMessage && warmupEnabled && onToggleAutoWarmup && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                onClick={onToggleAutoWarmup}
                disabled={autoWarmupManagedByAll}
                className={cn(
                  "whitespace-nowrap",
                  autoWarmupEnabled &&
                    "border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                )}
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
        {usageEnabled && !usageUnsupportedMessage && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={handleRefresh}
                disabled={isRefreshing}
              >
                <RefreshCw className={cn("size-4", isRefreshing && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh usage</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={onDelete}
              className="border-red-200 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/30"
            >
              <Trash2 className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove account</TooltipContent>
        </Tooltip>
      </div>
    </Card>
  );
}
