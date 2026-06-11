import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  LogOut,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Sun,
  User,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { useAccounts } from "./hooks/useAccounts";
import { useForceCloseCodexProcesses } from "./hooks/useForceCloseCodexProcesses";
import { AccountCard, AddAccountModal, TitleBar } from "./components";
import {
  type ActiveTool,
  type AuthMode,
  type ProcessInfo,
  type ToolKind,
  type UsageInfo,
} from "./types";
import {
  exportFullBackupFile,
  importFullBackupFile,
  invokeBackend,
  isTauriRuntime,
} from "./lib/platform";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import "./App.css";

const THEME_STORAGE_KEY = "ai-switcher-theme";
const ACTIVE_TOOL_STORAGE_KEY = "ai-switcher-active-tool";
const AUTO_WARMUP_ALL_STORAGE_KEY = "ai-switcher-auto-warmup-all";
const AUTO_WARMUP_ACCOUNTS_STORAGE_KEY = "ai-switcher-auto-warmup-accounts";
const AUTO_WARMUP_LEDGER_STORAGE_KEY = "ai-switcher-auto-warmup-last-success";
const AUTO_WARMUP_CHECK_INTERVAL_MS = 30 * 1000;
const AUTO_WARMUP_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const AUTO_WARMUP_MIN_SUCCESS_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_WARMUP_FULL_WINDOW_SLACK_MINUTES = 5;
const DEFAULT_PRIMARY_WINDOW_MINUTES = 300;
const LIMIT_FULL_THRESHOLD = 99.5;
const SWITCH_ACCOUNT_BLOCKED_EVENT = "switch-account-blocked";
type ThemeMode = "light" | "dark" | "system";
interface SwitchAccountBlockedPayload {
  accountId?: string;
  error?: string;
}
type AutoWarmupLedger = Record<
  string,
  {
    lastSuccessfulWarmupAt?: number;
  }
>;

const ACTIVE_TOOL_TO_BACKEND: Record<
  ActiveTool,
  { tool: ToolKind; authMode?: AuthMode }
> = {
  codex: { tool: "codex" },
  claude_code: { tool: "claude", authMode: "claude_code" },
  claude_desktop: { tool: "claude", authMode: "claude_desktop" },
};
type SortKey =
  | "deadline_asc"
  | "deadline_desc"
  | "remaining_desc"
  | "remaining_asc"
  | "subscription_asc"
  | "subscription_desc";

function readStoredStringArray(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readStoredAutoWarmupLedger(): AutoWarmupLedger {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AUTO_WARMUP_LEDGER_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([accountId, value]) => {
          const timestamp =
            value &&
            typeof value === "object" &&
            "lastSuccessfulWarmupAt" in value &&
            typeof value.lastSuccessfulWarmupAt === "number"
              ? value.lastSuccessfulWarmupAt
              : undefined;
          return timestamp ? [accountId, { lastSuccessfulWarmupAt: timestamp }] : null;
        })
        .filter((entry): entry is [string, { lastSuccessfulWarmupAt: number }] => Boolean(entry))
    );
  } catch {
    return {};
  }
}

function isLimitFull(usedPercent: number | null | undefined): boolean {
  return usedPercent !== null && usedPercent !== undefined && usedPercent >= LIMIT_FULL_THRESHOLD;
}

function getPrimaryWindowMinutes(usage: UsageInfo): number {
  return usage.primary_window_minutes ?? DEFAULT_PRIMARY_WINDOW_MINUTES;
}

function getPrimaryRemainingMs(usage: UsageInfo): number | null {
  if (!usage.primary_resets_at) return null;
  return usage.primary_resets_at * 1000 - Date.now();
}

function isPrimaryFullWindow(usage: UsageInfo): boolean {
  const remainingMs = getPrimaryRemainingMs(usage);
  if (remainingMs === null) return false;

  const thresholdMinutes = Math.max(
    0,
    getPrimaryWindowMinutes(usage) - AUTO_WARMUP_FULL_WINDOW_SLACK_MINUTES
  );
  return remainingMs >= thresholdMinutes * 60 * 1000;
}

function getLastSuccessfulWarmupAt(
  ledger: AutoWarmupLedger,
  accountId: string
): number | undefined {
  return ledger[accountId]?.lastSuccessfulWarmupAt;
}

// Process-status badge variant using semantic success/warning tokens.
function processBadgeVariant(isRunning: boolean): "warning" | "success" {
  return isRunning ? "warning" : "success";
}

function processDotClass(isRunning: boolean) {
  return isRunning ? "bg-warning" : "bg-success";
}

function App() {
  const [activeTool, setActiveTool] = useState<ActiveTool>(() => {
    if (typeof window === "undefined") return "codex";
    try {
      const saved = window.localStorage.getItem(ACTIVE_TOOL_STORAGE_KEY);
      if (saved === "codex" || saved === "claude_code" || saved === "claude_desktop") {
        return saved;
      }
      if (saved === "claude") return "claude_code";
      return "codex";
    } catch {
      return "codex";
    }
  });

  const backendTarget = ACTIVE_TOOL_TO_BACKEND[activeTool];

  const {
    accounts,
    loading,
    error,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    warmupAccount,
    warmupAllAccounts,
    switchAccount,
    deleteAccount,
    renameAccount,
    importFromFile,
    addClaudeFromCurrent,
    addClaudeDesktopFromCurrent,
    exportAccountsSlimText,
    importAccountsSlimText,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    startClaudeOAuthLogin,
    completeClaudeOAuthLogin,
    cancelClaudeOAuthLogin,
    logoutCurrent,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  } = useAccounts(backendTarget.tool, backendTarget.authMode);

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [configModalMode, setConfigModalMode] = useState<"slim_export" | "slim_import">(
    "slim_export"
  );
  const [configPayload, setConfigPayload] = useState("");
  const [configModalError, setConfigModalError] = useState<string | null>(null);
  const [configCopied, setConfigCopied] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [processInfoByTool, setProcessInfoByTool] = useState<
    Record<ToolKind, ProcessInfo | null>
  >({ codex: null, claude: null });
  const [pendingTraySwitchAccountId, setPendingTraySwitchAccountId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isOpeningCodex, setIsOpeningCodex] = useState(false);
  const [isExportingSlim, setIsExportingSlim] = useState(false);
  const [isImportingSlim, setIsImportingSlim] = useState(false);
  const [isExportingFull, setIsExportingFull] = useState(false);
  const [isImportingFull, setIsImportingFull] = useState(false);
  const [isWarmingAll, setIsWarmingAll] = useState(false);
  const [warmingUpId, setWarmingUpId] = useState<string | null>(null);
  const [autoWarmupAllEnabled, setAutoWarmupAllEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(AUTO_WARMUP_ALL_STORAGE_KEY) === "true";
  });
  const [autoWarmupAccountIds, setAutoWarmupAccountIds] = useState<Set<string>>(
    () => new Set(readStoredStringArray(AUTO_WARMUP_ACCOUNTS_STORAGE_KEY))
  );
  const [autoWarmupLedger, setAutoWarmupLedger] =
    useState<AutoWarmupLedger>(() => readStoredAutoWarmupLedger());
  const [autoWarmupRunningIds, setAutoWarmupRunningIds] = useState<Set<string>>(
    new Set()
  );
  const [maskedAccounts, setMaskedAccounts] = useState<Set<string>>(new Set());
  const [otherAccountsSort, setOtherAccountsSort] = useState<SortKey>("deadline_asc");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "system";
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "dark" || saved === "light" || saved === "system") return saved;
      return "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(ACTIVE_TOOL_STORAGE_KEY, activeTool);
    } catch {
      // Ignore storage errors; tab still works for current session.
    }
  }, [activeTool]);

  const accountsRef = useRef(accounts);
  const autoWarmupAccountIdsRef = useRef(autoWarmupAccountIds);
  const autoWarmupLedgerRef = useRef(autoWarmupLedger);
  const autoWarmupRunningIdsRef = useRef(autoWarmupRunningIds);
  const autoWarmupRetryAfterRef = useRef<Record<string, number>>({});
  const openCodexCheckTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    autoWarmupAccountIdsRef.current = autoWarmupAccountIds;
  }, [autoWarmupAccountIds]);

  useEffect(() => {
    autoWarmupRunningIdsRef.current = autoWarmupRunningIds;
  }, [autoWarmupRunningIds]);

  useEffect(
    () => () => {
      if (openCodexCheckTimeoutRef.current !== null) {
        window.clearTimeout(openCodexCheckTimeoutRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (loading || error) return;

    const validAccountIds = new Set(accounts.map((account) => account.id));

    setAutoWarmupAccountIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => validAccountIds.has(id)));
      return next.size === prev.size ? prev : next;
    });

    setAutoWarmupLedger((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([accountId]) => validAccountIds.has(accountId))
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });

    for (const accountId of Object.keys(autoWarmupRetryAfterRef.current)) {
      if (!validAccountIds.has(accountId)) {
        delete autoWarmupRetryAfterRef.current[accountId];
      }
    }
  }, [accounts, error, loading]);

  useEffect(() => {
    autoWarmupLedgerRef.current = autoWarmupLedger;
    try {
      window.localStorage.setItem(
        AUTO_WARMUP_LEDGER_STORAGE_KEY,
        JSON.stringify(autoWarmupLedger)
      );
    } catch {
      // Ignore storage errors; auto warm-up still works for the current session.
    }
  }, [autoWarmupLedger]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        AUTO_WARMUP_ALL_STORAGE_KEY,
        String(autoWarmupAllEnabled)
      );
    } catch {
      // Ignore storage errors; auto warm-up still works for the current session.
    }
  }, [autoWarmupAllEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        AUTO_WARMUP_ACCOUNTS_STORAGE_KEY,
        JSON.stringify(Array.from(autoWarmupAccountIds))
      );
    } catch {
      // Ignore storage errors; auto warm-up still works for the current session.
    }
  }, [autoWarmupAccountIds]);

  const toggleMask = (accountId: string) => {
    setMaskedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const allMasked =
    accounts.length > 0 && accounts.every((account) => maskedAccounts.has(account.id));

  const toggleMaskAll = () => {
    setMaskedAccounts((prev) => {
      const shouldMaskAll = !accounts.every((account) => prev.has(account.id));
      const next = shouldMaskAll
        ? new Set(accounts.map((account) => account.id))
        : new Set<string>();
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const checkProcesses = useCallback(async () => {
    const sameInfo = (a: ProcessInfo | null, b: ProcessInfo) =>
      !!a &&
      a.can_switch === b.can_switch &&
      a.count === b.count &&
      a.background_count === b.background_count &&
      a.pids.length === b.pids.length &&
      a.pids.every((pid, index) => pid === b.pids[index]);

    try {
      const [codex, claude] = await Promise.all([
        invokeBackend<ProcessInfo>("check_processes", { tool: "codex" }),
        invokeBackend<ProcessInfo>("check_processes", { tool: "claude" }),
      ]);
      setProcessInfoByTool((prev) => {
        if (sameInfo(prev.codex, codex) && sameInfo(prev.claude, claude)) {
          return prev;
        }
        return { codex, claude };
      });
      return { codex, claude };
    } catch (err) {
      console.error("Failed to check processes:", err);
      return null;
    }
  }, []);

  useEffect(() => {
    checkProcesses();
    const interval = setInterval(checkProcesses, 5000);
    return () => clearInterval(interval);
  }, [checkProcesses]);

  useEffect(() => {
    loadMaskedAccountIds().then((ids) => {
      if (ids.length > 0) {
        setMaskedAccounts(new Set(ids));
      }
    });
  }, [loadMaskedAccountIds]);

  useEffect(() => {
    const mq =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    const apply = () => {
      const isDark =
        themeMode === "dark" || (themeMode === "system" && !!mq?.matches);
      document.documentElement.classList.toggle("dark", isDark);
    };
    apply();
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore storage errors; theme still works for current session.
    }
    if (themeMode !== "system" || !mq) return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [themeMode]);

  const handleSwitch = async (accountId: string) => {
    const latest = await checkProcesses();
    if (latest && !latest[backendTarget.tool].can_switch) {
      return;
    }

    try {
      setSwitchingId(accountId);
      await switchAccount(accountId);
    } catch (err) {
      console.error("Failed to switch account:", err);
      toast.error(
        err instanceof Error ? err.message : "Failed to switch account"
      );
    } finally {
      setSwitchingId(null);
    }
  };

  const handleLogout = async () => {
    const latest = await checkProcesses();
    if (latest && !latest[backendTarget.tool].can_switch) {
      return;
    }

    try {
      setIsLoggingOut(true);
      await logoutCurrent();
      toast.success(`Logged out of ${activeToolLabel}`);
    } catch (err) {
      console.error("Failed to log out:", err);
      toast.error(err instanceof Error ? err.message : "Failed to log out");
    } finally {
      setIsLoggingOut(false);
    }
  };

  const handleDelete = async (accountId: string) => {
    if (deleteConfirmId !== accountId) {
      setDeleteConfirmId(accountId);
      toast.warning("Click delete again to confirm removal", { duration: 3000 });
      setTimeout(() => setDeleteConfirmId(null), 3000);
      return;
    }

    try {
      await deleteAccount(accountId);
      setDeleteConfirmId(null);
    } catch (err) {
      console.error("Failed to delete account:", err);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshUsage(undefined, { refreshMetadata: true });
      toast.success("Usage refreshed successfully");
    } finally {
      setIsRefreshing(false);
    }
  };

  const showWarmupToast = useCallback((message: string, isError = false) => {
    if (isError) {
      toast.error(message);
    } else {
      toast.success(message);
    }
  }, []);

  const formatWarmupError = useCallback((err: unknown) => {
    if (!err) return "Unknown error";
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  }, []);

  const checkCodexProcesses = useCallback(async () => {
    const latest = await checkProcesses();
    return latest?.codex ?? null;
  }, [checkProcesses]);

  const markSuccessfulWarmup = useCallback((accountId: string, timestamp = Date.now()) => {
    setAutoWarmupLedger((prev) => ({
      ...prev,
      [accountId]: { lastSuccessfulWarmupAt: timestamp },
    }));
  }, []);

  const {
    forceCloseConfirmOpen,
    setForceCloseConfirmOpen,
    isForceClosingCodex,
    forceCloseCodexProcesses,
  } = useForceCloseCodexProcesses({
    checkProcesses: checkCodexProcesses,
    showToast: showWarmupToast,
    formatError: formatWarmupError,
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      if (!isTauriRuntime()) return;
      const { listen } = await import("@tauri-apps/api/event");
      const fn = await listen<SwitchAccountBlockedPayload>(
        SWITCH_ACCOUNT_BLOCKED_EVENT,
        async (event) => {
          const latestProcessInfo = await checkProcesses();
          const accountId = event.payload?.accountId;

          if (accountId && latestProcessInfo && !latestProcessInfo.codex.can_switch) {
            setPendingTraySwitchAccountId(accountId);
            setForceCloseConfirmOpen(true);
            return;
          }

          if (accountId && latestProcessInfo?.codex.can_switch) {
            try {
              setSwitchingId(accountId);
              await switchAccount(accountId);
              setPendingTraySwitchAccountId(null);
              showWarmupToast("Switched account from tray.");
            } catch (err) {
              console.error("Failed to retry tray account switch:", err);
              showWarmupToast(`Switch failed: ${formatWarmupError(err)}`, true);
            } finally {
              setSwitchingId(null);
            }
            return;
          }

          showWarmupToast(
            event.payload?.error || "Account switch was blocked.",
            true
          );
        }
      );
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [checkProcesses, formatWarmupError, setForceCloseConfirmOpen, showWarmupToast, switchAccount]);

  const handleForceCloseConfirm = useCallback(async () => {
    const accountId = pendingTraySwitchAccountId;
    const latestProcessInfo = await forceCloseCodexProcesses();

    if (!accountId) {
      return;
    }

    if (!latestProcessInfo?.can_switch) {
      setPendingTraySwitchAccountId(null);
      return;
    }

    try {
      setSwitchingId(accountId);
      await switchAccount(accountId);
      setPendingTraySwitchAccountId(null);
      showWarmupToast("Switched account after force closing Codex.");
    } catch (err) {
      console.error("Failed to switch account after force close:", err);
      setPendingTraySwitchAccountId(null);
      showWarmupToast(
        `Switch failed after force close: ${formatWarmupError(err)}`,
        true
      );
    } finally {
      setSwitchingId(null);
    }
  }, [
    forceCloseCodexProcesses,
    formatWarmupError,
    pendingTraySwitchAccountId,
    showWarmupToast,
    switchAccount,
  ]);

  const handleWarmupAccount = async (accountId: string, accountName: string) => {
    try {
      setWarmingUpId(accountId);
      await warmupAccount(accountId);
      markSuccessfulWarmup(accountId);
      toast.success(`Warm-up sent for ${accountName}`);
    } catch (err) {
      console.error("Failed to warm up account:", err);
      toast.error(`Warm-up failed for ${accountName}: ${formatWarmupError(err)}`);
    } finally {
      setWarmingUpId(null);
    }
  };

  const handleWarmupAll = async () => {
    try {
      setIsWarmingAll(true);
      const summary = await warmupAllAccounts();
      if (summary.total_accounts === 0) {
        toast.error("No accounts available for warm-up");
        return;
      }

      const warmedAt = Date.now();
      const failedAccountIds = new Set(summary.failed_account_ids);
      accounts.forEach((account) => {
        if (!failedAccountIds.has(account.id)) {
          markSuccessfulWarmup(account.id, warmedAt);
        }
      });

      if (summary.failed_account_ids.length === 0) {
        toast.success(
          `Warm-up sent for all ${summary.warmed_accounts} ${pluralize(summary.warmed_accounts, "account")}`
        );
      } else {
        toast.error(
          `Warmed ${summary.warmed_accounts}/${summary.total_accounts}. Failed: ${summary.failed_account_ids.length}`
        );
      }
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      toast.error(`Warm-up all failed: ${formatWarmupError(err)}`);
    } finally {
      setIsWarmingAll(false);
    }
  };

  const toggleAutoWarmupAccount = (accountId: string) => {
    setAutoWarmupAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const isAutoWarmupDue = useCallback(
    (accountId: string, usage: UsageInfo | undefined) => {
      if (!usage || usage.error || !usage.primary_resets_at) return false;
      if (isLimitFull(usage.secondary_used_percent)) return false;
      if (!isPrimaryFullWindow(usage)) return false;

      const lastSuccessfulWarmupAt = getLastSuccessfulWarmupAt(
        autoWarmupLedgerRef.current,
        accountId
      );
      if (
        lastSuccessfulWarmupAt &&
        Date.now() - lastSuccessfulWarmupAt < AUTO_WARMUP_MIN_SUCCESS_INTERVAL_MS
      ) {
        return false;
      }

      return true;
    },
    []
  );

  const getAutoWarmupLabel = useCallback(
    (
      usage: UsageInfo | undefined,
      isEnabled: boolean,
      isRunning: boolean
    ) => {
      if (isRunning) return "Warming...";
      if (!isEnabled) return "Auto: off";
      if (!usage || usage.error || !usage.primary_resets_at) return "Auto: on";

      if (isLimitFull(usage.secondary_used_percent)) {
        return "Waiting weekly reset";
      }

      return "Auto: on";
    },
    []
  );

  const headerAutoWarmupLabel = useMemo(() => {
    if (autoWarmupRunningIds.size > 0) return "Auto warming...";
    return autoWarmupAllEnabled || autoWarmupAccountIds.size > 0
      ? "Auto: on"
      : "Auto: off";
  }, [autoWarmupAccountIds.size, autoWarmupAllEnabled, autoWarmupRunningIds]);

  const backOffAutoWarmupRetry = useCallback((accountId: string) => {
    autoWarmupRetryAfterRef.current[accountId] =
      Date.now() + AUTO_WARMUP_RETRY_BACKOFF_MS;
  }, []);

  const runAutoWarmupForAccount = useCallback(
    async (accountId: string, accountName: string) => {
      setAutoWarmupRunningIds((prev) => new Set(prev).add(accountId));

      try {
        let freshUsage: UsageInfo | undefined;
        try {
          freshUsage = await refreshSingleUsage(accountId);
        } catch (err) {
          console.error("Auto warm-up usage refresh failed:", err);
          backOffAutoWarmupRetry(accountId);
          return;
        }

        if (!freshUsage || freshUsage.error || !freshUsage.primary_resets_at) {
          backOffAutoWarmupRetry(accountId);
          return;
        }
        if (!isAutoWarmupDue(accountId, freshUsage)) {
          return;
        }

        await warmupAccount(accountId);
        markSuccessfulWarmup(accountId);
        showWarmupToast(`Auto warm-up sent for ${accountName}`);
      } catch (err) {
        console.error("Auto warm-up failed:", err);
        backOffAutoWarmupRetry(accountId);
        showWarmupToast(
          `Auto warm-up failed for ${accountName}: ${formatWarmupError(err)}`,
          true
        );
      } finally {
        setAutoWarmupRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(accountId);
          return next;
        });
      }
    },
    [
      backOffAutoWarmupRetry,
      formatWarmupError,
      isAutoWarmupDue,
      markSuccessfulWarmup,
      refreshSingleUsage,
      showWarmupToast,
      warmupAccount,
    ]
  );

  useEffect(() => {
    if (!autoWarmupAllEnabled && autoWarmupAccountIds.size === 0) return;

    const checkAutoWarmup = () => {
      for (const account of accountsRef.current) {
        const autoEnabled =
          autoWarmupAllEnabled || autoWarmupAccountIdsRef.current.has(account.id);
        if (!autoEnabled || autoWarmupRunningIdsRef.current.has(account.id)) continue;

        const retryAfter = autoWarmupRetryAfterRef.current[account.id];
        if (retryAfter && Date.now() < retryAfter) continue;

        if (!isAutoWarmupDue(account.id, account.usage)) continue;

        void runAutoWarmupForAccount(account.id, account.name);
      }
    };

    checkAutoWarmup();
    const interval = window.setInterval(
      checkAutoWarmup,
      AUTO_WARMUP_CHECK_INTERVAL_MS
    );

    return () => window.clearInterval(interval);
  }, [
    autoWarmupAccountIds.size,
    autoWarmupAllEnabled,
    isAutoWarmupDue,
    runAutoWarmupForAccount,
  ]);

  const handleExportSlimText = async () => {
    setConfigModalMode("slim_export");
    setConfigModalError(null);
    setConfigPayload("");
    setConfigCopied(false);
    setIsConfigModalOpen(true);

    try {
      setIsExportingSlim(true);
      const payload = await exportAccountsSlimText();
      setConfigPayload(payload);
      toast.success(`Slim text exported (${accounts.length} accounts).`);
    } catch (err) {
      console.error("Failed to export slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      toast.error("Slim export failed");
    } finally {
      setIsExportingSlim(false);
    }
  };

  const openImportSlimTextModal = () => {
    setConfigModalMode("slim_import");
    setConfigModalError(null);
    setConfigPayload("");
    setConfigCopied(false);
    setIsConfigModalOpen(true);
  };

  const handleImportSlimText = async () => {
    if (!configPayload.trim()) {
      setConfigModalError("Please paste the slim text string first.");
      return;
    }

    try {
      setIsImportingSlim(true);
      setConfigModalError(null);
      const summary = await importAccountsSlimText(configPayload);
      setMaskedAccounts(new Set());
      setIsConfigModalOpen(false);
      toast.success(
        `Imported ${summary.imported_count}, skipped ${summary.skipped_count} (total ${summary.total_in_payload})`
      );
    } catch (err) {
      console.error("Failed to import slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      toast.error("Slim import failed");
    } finally {
      setIsImportingSlim(false);
    }
  };

  const handleExportFullFile = async () => {
    try {
      setIsExportingFull(true);
      const exported = await exportFullBackupFile();
      if (!exported) return;
      toast.success("Full encrypted file exported.");
    } catch (err) {
      console.error("Failed to export full encrypted file:", err);
      toast.error("Full export failed");
    } finally {
      setIsExportingFull(false);
    }
  };

  const handleImportFullFile = async () => {
    try {
      setIsImportingFull(true);
      const summary = await importFullBackupFile();
      if (!summary) return;
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
      const maskedIds = await loadMaskedAccountIds();
      setMaskedAccounts(new Set(maskedIds));
      toast.success(
        `Imported ${summary.imported_count}, skipped ${summary.skipped_count} (total ${summary.total_in_payload})`
      );
    } catch (err) {
      console.error("Failed to import full encrypted file:", err);
      toast.error("Full import failed");
    } finally {
      setIsImportingFull(false);
    }
  };

  const handleOpenCodexApp = useCallback(async () => {
    try {
      setIsOpeningCodex(true);
      await invokeBackend("open_codex_app");
      showWarmupToast("Codex app opened.");
      if (openCodexCheckTimeoutRef.current !== null) {
        window.clearTimeout(openCodexCheckTimeoutRef.current);
      }
      openCodexCheckTimeoutRef.current = window.setTimeout(() => {
        openCodexCheckTimeoutRef.current = null;
        void checkProcesses();
      }, 1500);
    } catch (err) {
      console.error("Failed to open Codex app:", err);
      showWarmupToast(`Open Codex failed: ${formatWarmupError(err)}`, true);
    } finally {
      setIsOpeningCodex(false);
    }
  }, [checkProcesses, formatWarmupError, showWarmupToast]);

  const activeAccount = accounts.find((a) => a.is_active);
  const otherAccounts = accounts.filter((a) => !a.is_active);
  const codexProcessInfo = processInfoByTool.codex;
  const claudeProcessInfo = processInfoByTool.claude;
  const hasRunningCodex = !!codexProcessInfo && codexProcessInfo.count > 0;
  const codexProcessCount = codexProcessInfo?.count ?? 0;
  const hasRunningClaude = !!claudeProcessInfo && claudeProcessInfo.count > 0;
  const usageEnabled = true;
  const warmupEnabled = activeTool === "codex";
  const hasRunningActiveTool =
    activeTool === "codex" ? hasRunningCodex : hasRunningClaude;
  const activeToolLabel =
    activeTool === "codex"
      ? "Codex"
      : activeTool === "claude_code"
        ? "Claude Code"
        : "Claude Desktop";
  const switchDisabledLabel =
    activeTool === "codex" ? "Codex Running" : "Claude Running";
  const switchDisabledTooltip =
    activeTool === "codex"
      ? "Close all Codex processes first"
      : "Close all Claude processes first";
  const pendingTraySwitchAccount = useMemo(
    () => accounts.find((account) => account.id === pendingTraySwitchAccountId),
    [accounts, pendingTraySwitchAccountId]
  );
  const forceCloseConfirmLabel = pendingTraySwitchAccount
    ? "Force close and switch account"
    : "Force close running Codex processes";

  const sortedOtherAccounts = useMemo(() => {
    if (activeTool !== "codex") {
      return [...otherAccounts].sort((a, b) => a.name.localeCompare(b.name));
    }

    const getResetDeadline = (resetAt: number | null | undefined) =>
      resetAt ?? Number.POSITIVE_INFINITY;

    const getSubscriptionDeadline = (expiresAt: string | null | undefined) => {
      if (!expiresAt) return null;
      const timestamp = new Date(expiresAt).getTime();
      return Number.isNaN(timestamp) ? null : timestamp;
    };

    const compareOptionalNumber = (
      aValue: number | null,
      bValue: number | null,
      direction: "asc" | "desc"
    ) => {
      if (aValue === null && bValue === null) return 0;
      if (aValue === null) return 1;
      if (bValue === null) return -1;
      return direction === "asc" ? aValue - bValue : bValue - aValue;
    };

    const getRemainingPercent = (usedPercent: number | null | undefined) => {
      if (usedPercent === null || usedPercent === undefined) {
        return Number.NEGATIVE_INFINITY;
      }
      return Math.max(0, 100 - usedPercent);
    };

    return [...otherAccounts].sort((a, b) => {
      if (
        otherAccountsSort === "subscription_asc" ||
        otherAccountsSort === "subscription_desc"
      ) {
        const subscriptionDiff = compareOptionalNumber(
          getSubscriptionDeadline(a.subscription_expires_at),
          getSubscriptionDeadline(b.subscription_expires_at),
          otherAccountsSort === "subscription_asc" ? "asc" : "desc"
        );
        if (subscriptionDiff !== 0) return subscriptionDiff;

        const deadlineDiff =
          getResetDeadline(a.usage?.primary_resets_at) -
          getResetDeadline(b.usage?.primary_resets_at);
        if (deadlineDiff !== 0) return deadlineDiff;

        const remainingDiff =
          getRemainingPercent(b.usage?.primary_used_percent) -
          getRemainingPercent(a.usage?.primary_used_percent);
        if (remainingDiff !== 0) return remainingDiff;

        return a.name.localeCompare(b.name);
      }

      if (otherAccountsSort === "deadline_asc" || otherAccountsSort === "deadline_desc") {
        const deadlineDiff =
          getResetDeadline(a.usage?.primary_resets_at) -
          getResetDeadline(b.usage?.primary_resets_at);
        if (deadlineDiff !== 0) {
          return otherAccountsSort === "deadline_asc" ? deadlineDiff : -deadlineDiff;
        }
        const remainingDiff =
          getRemainingPercent(b.usage?.primary_used_percent) -
          getRemainingPercent(a.usage?.primary_used_percent);
        if (remainingDiff !== 0) return remainingDiff;
        return a.name.localeCompare(b.name);
      }

      const remainingDiff =
        getRemainingPercent(b.usage?.primary_used_percent) -
        getRemainingPercent(a.usage?.primary_used_percent);
      if (otherAccountsSort === "remaining_desc" && remainingDiff !== 0) {
        return remainingDiff;
      }
      if (otherAccountsSort === "remaining_asc" && remainingDiff !== 0) {
        return -remainingDiff;
      }
      const deadlineDiff =
        getResetDeadline(a.usage?.primary_resets_at) -
        getResetDeadline(b.usage?.primary_resets_at);
      if (deadlineDiff !== 0) return deadlineDiff;
      return a.name.localeCompare(b.name);
    });
  }, [activeTool, otherAccounts, otherAccountsSort]);

  const themeIcon =
    themeMode === "system" ? Monitor : themeMode === "light" ? Sun : Moon;
  const ThemeIcon = themeIcon;
  const cycleTheme = () =>
    setThemeMode((prev) =>
      prev === "system" ? "light" : prev === "light" ? "dark" : "system"
    );
  const themeTitle =
    themeMode === "system"
      ? "Theme: system — click for light"
      : themeMode === "light"
        ? "Theme: light — click for dark"
        : "Theme: dark — click for system";

  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="bg-background sticky top-0 z-50">
        <TitleBar />
      </div>
      <header className="bg-background sticky top-14 z-40 border-b">

        <div className="mx-auto max-w-5xl px-6 py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_max-content] md:items-center md:gap-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-foreground text-xl font-bold tracking-tight">
                    AI Switcher
                  </h1>
                  {codexProcessInfo && (
                    <Badge variant={processBadgeVariant(hasRunningCodex)}>
                      <span
                        className={cn(
                          "inline-block size-1.5 rounded-full",
                          processDotClass(hasRunningCodex)
                        )}
                      />
                      {codexProcessInfo.count} Codex running
                    </Badge>
                  )}
                  {hasRunningCodex && (
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() => {
                        setPendingTraySwitchAccountId(null);
                        setForceCloseConfirmOpen(true);
                      }}
                      disabled={isForceClosingCodex}
                    >
                      Force close
                    </Button>
                  )}
                  {isTauriRuntime() && codexProcessInfo && !hasRunningCodex && (
                    <Button
                      variant="success"
                      size="xs"
                      onClick={handleOpenCodexApp}
                      disabled={isOpeningCodex}
                    >
                      {isOpeningCodex ? "Opening..." : "Open Codex"}
                    </Button>
                  )}
                  {claudeProcessInfo && (
                    <Badge variant={processBadgeVariant(hasRunningClaude)}>
                      <span
                        className={cn(
                          "inline-block size-1.5 rounded-full",
                          processDotClass(hasRunningClaude)
                        )}
                      />
                      {claudeProcessInfo.count} Claude running
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2 md:ml-4 md:w-max md:flex-nowrap md:justify-end">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={toggleMaskAll}
                    aria-label={allMasked ? "Show all account names and emails" : "Hide all account names and emails"}
                  >
                    {allMasked ? <EyeOff /> : <Eye />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {allMasked
                    ? "Show all account names and emails"
                    : "Hide all account names and emails"}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                    aria-label={isRefreshing ? "Refreshing all usage" : "Refresh all usage"}
                  >
                    <RefreshCw className={cn(isRefreshing && "animate-spin")} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isRefreshing ? "Refreshing all usage" : "Refresh all usage"}
                </TooltipContent>
              </Tooltip>
              {warmupEnabled && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleWarmupAll}
                      disabled={isWarmingAll || accounts.length === 0}
                      aria-label="Send minimal traffic using all accounts"
                    >
                      <Zap className={cn(isWarmingAll && "animate-pulse")} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Send minimal traffic using all accounts</TooltipContent>
                </Tooltip>
              )}
              {warmupEnabled && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={autoWarmupAllEnabled ? "success" : "outline"}
                      onClick={() => setAutoWarmupAllEnabled((prev) => !prev)}
                      disabled={accounts.length === 0}
                      className="whitespace-nowrap"
                    >
                      {headerAutoWarmupLabel}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {autoWarmupAllEnabled
                      ? "Disable auto warm-up for all accounts"
                      : "Enable auto warm-up for all accounts"}
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" onClick={cycleTheme} aria-label={themeTitle}>
                    <ThemeIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{themeTitle}</TooltipContent>
              </Tooltip>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button>
                    Account
                    <ChevronDown data-icon="inline-end" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem
                    onSelect={() => {
                      void checkProcesses();
                      setIsAddModalOpen(true);
                    }}
                  >
                    <Plus />
                    Add Account
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={isExportingSlim}
                    onSelect={() => {
                      void handleExportSlimText();
                    }}
                  >
                    {isExportingSlim ? "Exporting..." : "Export Slim Text"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={isImportingSlim}
                    onSelect={openImportSlimTextModal}
                  >
                    {isImportingSlim ? "Importing..." : "Import Slim Text"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={isExportingFull}
                    onSelect={() => {
                      void handleExportFullFile();
                    }}
                  >
                    {isExportingFull ? "Exporting..." : "Export Full Encrypted File"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={isImportingFull}
                    onSelect={() => {
                      void handleImportFullFile();
                    }}
                  >
                    {isImportingFull ? "Importing..." : "Import Full Encrypted File"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>

        <Tabs
          value={activeTool}
          onValueChange={(v) => setActiveTool(v as ActiveTool)}
        >
          <div className="mx-auto max-w-5xl px-6">
            <TabsList variant="line" className="flex w-full">
              <TabsTrigger value="codex">Codex</TabsTrigger>
              <TabsTrigger value="claude_code">Claude Code</TabsTrigger>
              <TabsTrigger value="claude_desktop">Claude Desktop</TabsTrigger>
            </TabsList>
          </div>
        </Tabs>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {loading && accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <Spinner className="text-foreground size-10" />
            <p className="text-muted-foreground">Loading accounts...</p>
          </div>
        ) : error ? (
          <Alert variant="destructive" className="mx-auto max-w-md">
            <AlertTitle>Failed to load accounts</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : accounts.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {activeTool === "codex" ? <User /> : <Bot />}
              </EmptyMedia>
              <EmptyTitle>No accounts yet</EmptyTitle>
              <EmptyDescription>
                Add your first{" "}
                {activeTool === "codex"
                  ? "Codex"
                  : activeTool === "claude_code"
                    ? "Claude Code"
                    : "Claude Desktop"}{" "}
                account to get started
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                onClick={() => {
                  void checkProcesses();
                  setIsAddModalOpen(true);
                }}
              >
                Add Account
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="flex flex-col gap-8">
            {activeAccount && (
              <section>
                <h2 className="text-muted-foreground mb-4 text-sm font-medium uppercase tracking-wider">
                  Active Account
                </h2>
                <AccountCard
                  account={activeAccount}
                  onSwitch={() => {}}
                  onWarmup={() =>
                    handleWarmupAccount(activeAccount.id, activeAccount.name)
                  }
                  onDelete={() => handleDelete(activeAccount.id)}
                  onRefresh={() =>
                    refreshSingleUsage(activeAccount.id, { refreshMetadata: true })
                  }
                  onRename={(newName) => renameAccount(activeAccount.id, newName)}
                  switching={switchingId === activeAccount.id}
                  switchDisabled={hasRunningActiveTool}
                  switchDisabledLabel={switchDisabledLabel}
                  switchDisabledTooltip={switchDisabledTooltip}
                  warmingUp={
                    isWarmingAll ||
                    warmingUpId === activeAccount.id ||
                    autoWarmupRunningIds.has(activeAccount.id)
                  }
                  masked={maskedAccounts.has(activeAccount.id)}
                  usageEnabled={usageEnabled}
                  warmupEnabled={warmupEnabled}
                  onToggleMask={() => toggleMask(activeAccount.id)}
                  autoWarmupEnabled={
                    autoWarmupAllEnabled || autoWarmupAccountIds.has(activeAccount.id)
                  }
                  autoWarmupManagedByAll={autoWarmupAllEnabled}
                  autoWarmupLabel={getAutoWarmupLabel(
                    activeAccount.usage,
                    autoWarmupAllEnabled || autoWarmupAccountIds.has(activeAccount.id),
                    autoWarmupRunningIds.has(activeAccount.id)
                  )}
                  onToggleAutoWarmup={
                    warmupEnabled
                      ? () => toggleAutoWarmupAccount(activeAccount.id)
                      : undefined
                  }
                />
              </section>
            )}

            {otherAccounts.length > 0 && (
              <section>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="text-muted-foreground text-sm font-medium uppercase tracking-wider">
                    Other Accounts ({otherAccounts.length})
                  </h2>
                  {activeTool === "codex" && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs">Sort</span>
                      <Select
                        value={otherAccountsSort}
                        onValueChange={(v) => setOtherAccountsSort(v as SortKey)}
                      >
                        <SelectTrigger size="sm" className="w-auto">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="end">
                          <SelectItem value="deadline_asc">
                            Reset: earliest to latest
                          </SelectItem>
                          <SelectItem value="deadline_desc">
                            Reset: latest to earliest
                          </SelectItem>
                          <SelectItem value="remaining_desc">
                            % remaining: highest to lowest
                          </SelectItem>
                          <SelectItem value="remaining_asc">
                            % remaining: lowest to highest
                          </SelectItem>
                          <SelectItem value="subscription_asc">
                            Expiry: earliest to latest
                          </SelectItem>
                          <SelectItem value="subscription_desc">
                            Expiry: latest to earliest
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {sortedOtherAccounts.map((account) => (
                    <AccountCard
                      key={account.id}
                      account={account}
                      onSwitch={() => handleSwitch(account.id)}
                      onWarmup={() => handleWarmupAccount(account.id, account.name)}
                      onDelete={() => handleDelete(account.id)}
                      onRefresh={() =>
                        refreshSingleUsage(account.id, { refreshMetadata: true })
                      }
                      onRename={(newName) => renameAccount(account.id, newName)}
                      switching={switchingId === account.id}
                      switchDisabled={hasRunningActiveTool}
                      switchDisabledLabel={switchDisabledLabel}
                      switchDisabledTooltip={switchDisabledTooltip}
                      warmingUp={
                        isWarmingAll ||
                        warmingUpId === account.id ||
                        autoWarmupRunningIds.has(account.id)
                      }
                      masked={maskedAccounts.has(account.id)}
                      usageEnabled={usageEnabled}
                      warmupEnabled={warmupEnabled}
                      onToggleMask={() => toggleMask(account.id)}
                      autoWarmupEnabled={
                        autoWarmupAllEnabled || autoWarmupAccountIds.has(account.id)
                      }
                      autoWarmupManagedByAll={autoWarmupAllEnabled}
                      autoWarmupLabel={getAutoWarmupLabel(
                        account.usage,
                        autoWarmupAllEnabled || autoWarmupAccountIds.has(account.id),
                        autoWarmupRunningIds.has(account.id)
                      )}
                      onToggleAutoWarmup={
                        warmupEnabled
                          ? () => toggleAutoWarmupAccount(account.id)
                          : undefined
                      }
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {!error && !(loading && accounts.length === 0) && (
          <section className="mt-8">
            <h2 className="text-muted-foreground mb-4 text-sm font-medium uppercase tracking-wider">
              Other Options
            </h2>
            <Card>
              <CardHeader>
                <CardTitle>Log out of {activeToolLabel}</CardTitle>
                <CardDescription>
                  Clear the current {activeToolLabel} login on this machine.
                  Saved accounts and their tokens are kept.
                </CardDescription>
                <CardAction>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        onClick={handleLogout}
                        disabled={
                          isLoggingOut || hasRunningActiveTool || !activeAccount
                        }
                      >
                        {!activeAccount && !isLoggingOut ? (
                          <Check data-icon="inline-start" />
                        ) : (
                          <LogOut data-icon="inline-start" />
                        )}
                        {isLoggingOut
                          ? "Logging out..."
                          : !activeAccount
                            ? "Logged out"
                            : hasRunningActiveTool
                              ? switchDisabledLabel
                              : "Log out"}
                      </Button>
                    </TooltipTrigger>
                    {hasRunningActiveTool && activeAccount && (
                      <TooltipContent>{switchDisabledTooltip}</TooltipContent>
                    )}
                  </Tooltip>
                </CardAction>
              </CardHeader>
            </Card>
          </section>
        )}
      </main>

      <AlertDialog
        open={forceCloseConfirmOpen}
        onOpenChange={(open) => {
          if (isForceClosingCodex && !open) {
            return;
          }
          if (!open) {
            setPendingTraySwitchAccountId(null);
          }
          setForceCloseConfirmOpen(open);
        }}
      >
        <AlertDialogContent
          onEscapeKeyDown={(event) => {
            if (isForceClosingCodex) {
              event.preventDefault();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Force close running Codex processes?</AlertDialogTitle>
            <AlertDialogDescription>
              This will force close {codexProcessCount}{" "}
              {pluralize(codexProcessCount, "Codex process", "Codex processes")} that currently
              block account switching.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3">
            {pendingTraySwitchAccount && (
              <p className="text-muted-foreground text-sm">
                After closing Codex, AI Switcher will switch to{" "}
                <span className="text-foreground font-medium">
                  {pendingTraySwitchAccount.name}
                </span>
                .
              </p>
            )}
            <Alert variant="destructive">
              <AlertDescription>Unsaved Codex work may be lost.</AlertDescription>
            </Alert>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setPendingTraySwitchAccountId(null);
                setForceCloseConfirmOpen(false);
              }}
              disabled={isForceClosingCodex}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                void handleForceCloseConfirm();
              }}
              disabled={isForceClosingCodex}
            >
              {isForceClosingCodex ? "Force closing..." : forceCloseConfirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AddAccountModal
        isOpen={isAddModalOpen}
        activeTool={activeTool}
        onClose={() => setIsAddModalOpen(false)}
        onImportFile={importFromFile}
        onAddClaudeFromCurrent={addClaudeFromCurrent}
        onAddClaudeDesktopFromCurrent={addClaudeDesktopFromCurrent}
        claudeDesktopImportBlocked={activeTool === "claude_desktop" && hasRunningClaude}
        onStartOAuth={startOAuthLogin}
        onCompleteOAuth={completeOAuthLogin}
        onCancelOAuth={cancelOAuthLogin}
        onStartClaudeOAuth={startClaudeOAuthLogin}
        onCompleteClaudeOAuth={completeClaudeOAuthLogin}
        onCancelClaudeOAuth={cancelClaudeOAuthLogin}
      />

      <Dialog
        open={isConfigModalOpen}
        onOpenChange={setIsConfigModalOpen}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {configModalMode === "slim_export" ? "Export Slim Text" : "Import Slim Text"}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {configModalMode === "slim_import" ? (
              <Alert variant="warning">
                <AlertDescription>
                  Existing accounts are kept. Only missing accounts are imported.
                </AlertDescription>
              </Alert>
            ) : (
              <p className="text-muted-foreground text-sm">
                This slim string contains account secrets. Keep it private.
              </p>
            )}
            <Textarea
              value={configPayload}
              onChange={(e) => setConfigPayload(e.target.value)}
              readOnly={configModalMode === "slim_export"}
              placeholder={
                configModalMode === "slim_export"
                  ? isExportingSlim
                    ? "Generating..."
                    : "Export string will appear here"
                  : "Paste config string here"
              }
              className="h-48 font-mono"
            />
            {configModalError && (
              <Alert variant="destructive">
                <AlertDescription>{configModalError}</AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsConfigModalOpen(false)}>
              Close
            </Button>
            {configModalMode === "slim_export" ? (
              <Button
                onClick={async () => {
                  if (!configPayload) return;
                  try {
                    await navigator.clipboard.writeText(configPayload);
                    setConfigCopied(true);
                    setTimeout(() => setConfigCopied(false), 1500);
                  } catch {
                    setConfigModalError("Clipboard unavailable. Please copy manually.");
                  }
                }}
                disabled={!configPayload || isExportingSlim}
              >
                {configCopied ? "Copied" : "Copy String"}
              </Button>
            ) : (
              <Button onClick={handleImportSlimText} disabled={isImportingSlim}>
                {isImportingSlim ? "Importing..." : "Import Missing Accounts"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Toaster richColors position="bottom-center" />
    </div>
  );
}

export default App;
