import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Gamepad2,
  LogOut,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Settings,
  Sun,
  User,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { useAccounts } from "@/hooks/useAccounts";
import { useForceCloseCodexProcesses } from "@/hooks/useForceCloseCodexProcesses";
import { useDesktopReopen } from "@/hooks/useDesktopReopen";
import { useCodexClosePreference } from "@/hooks/useCodexClosePreference";
import { SettingsModal } from "@/components/SettingsModal";
import { finishForceClose, type DesktopReopenPreference } from "@/lib/desktopReopen";
import type { CodexClosePreference } from "@/lib/codexClosePreference";
import { AccountCard, AddAccountModal, AppFooter } from "@/components";
import {
  type AccountWithUsage,
  type ActiveTool,
  type AuthMode,
  type ProcessInfo,
  type ToolKind,
  type UsageInfo,
} from "@/types";
import {
  exportFullBackupFile,
  importFullBackupFile,
  invokeBackend,
  isTauriRuntime,
  setWindowTheme,
} from "@/lib/platform";
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
import {
  getAutoWarmupWindowKey,
  getAutoWarmupWindowKind,
  getDueAutoWarmupWindow,
  type AutoWarmupWindow,
  type AutoWarmupWindowKind,
} from "@/lib/autoWarmupPolicy";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import "@/App.css";

const THEME_STORAGE_KEY = "ai-switcher-theme";
const ACTIVE_TOOL_STORAGE_KEY = "ai-switcher-active-tool";
const AUTO_WARMUP_ALL_STORAGE_KEY = "ai-switcher-auto-warmup-all";
const AUTO_WARMUP_ACCOUNTS_STORAGE_KEY = "ai-switcher-auto-warmup-accounts";
const AUTO_WARMUP_LEDGER_STORAGE_KEY = "ai-switcher-auto-warmup-last-success";
const AUTO_WARMUP_CHECK_INTERVAL_MS = 30 * 1000;
const AUTO_WARMUP_RETRY_BACKOFF_MS = 60 * 1000;
const LIMIT_FULL_THRESHOLD = 99.5;
const ACCOUNT_SEARCH_THRESHOLD = 8;
type ThemeMode = "light" | "dark" | "system";
type AutoWarmupLedger = Record<
  string,
  {
    lastSuccessfulWarmupAt?: number;
    lastAutoWindowKey?: string;
    lastAutoWindowKind?: AutoWarmupWindowKind;
  }
>;

const resolveThemeDark = (themeMode: ThemeMode, prefersDark: boolean) =>
  themeMode === "dark" || (themeMode === "system" && prefersDark);

const ACTIVE_TOOL_TO_BACKEND: Record<
  ActiveTool,
  { tool: ToolKind; authMode?: AuthMode }
> = {
  codex: { tool: "codex" },
  claude_code: { tool: "claude", authMode: "claude_code" },
  claude_desktop: { tool: "claude", authMode: "claude_desktop" },
  cursor: { tool: "cursor" },
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

    const entries: Array<[string, AutoWarmupLedger[string]]> = [];
    for (const [accountId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;

      const entry: AutoWarmupLedger[string] = {};
      if (
        "lastSuccessfulWarmupAt" in value &&
        typeof value.lastSuccessfulWarmupAt === "number"
      ) {
        entry.lastSuccessfulWarmupAt = value.lastSuccessfulWarmupAt;
      }
      if ("lastAutoWindowKey" in value && typeof value.lastAutoWindowKey === "string") {
        entry.lastAutoWindowKey = value.lastAutoWindowKey;
      }
      if (
        "lastAutoWindowKind" in value &&
        (value.lastAutoWindowKind === "session" || value.lastAutoWindowKind === "weekly")
      ) {
        entry.lastAutoWindowKind = value.lastAutoWindowKind;
      }

      if (Object.keys(entry).length > 0) entries.push([accountId, entry]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function isLimitFull(usedPercent: number | null | undefined): boolean {
  return usedPercent !== null && usedPercent !== undefined && usedPercent >= LIMIT_FULL_THRESHOLD;
}

function getPreferredUsedPercent(usage: UsageInfo | undefined): number | null | undefined {
  return usage?.primary_used_percent ?? usage?.secondary_used_percent;
}

function getPreferredResetsAt(usage: UsageInfo | undefined): number | null | undefined {
  return usage?.primary_resets_at ?? usage?.secondary_resets_at;
}

// Process-status badge variant using semantic success/warning tokens.
function processBadgeVariant(isRunning: boolean): "warning" | "success" {
  return isRunning ? "warning" : "success";
}

function processDotClass(isRunning: boolean) {
  return isRunning ? "bg-warning" : "bg-success";
}

function matchesAccountSearch(
  account: AccountWithUsage,
  normalizedQuery: string
): boolean {
  if (!normalizedQuery) return true;

  return (
    account.name.toLowerCase().includes(normalizedQuery) ||
    account.email?.toLowerCase().includes(normalizedQuery) === true
  );
}

function App() {
  const [activeTool, setActiveTool] = useState<ActiveTool>(() => {
    if (typeof window === "undefined") return "codex";
    try {
      const saved = window.localStorage.getItem(ACTIVE_TOOL_STORAGE_KEY);
      if (
        saved === "codex" ||
        saved === "claude_code" ||
        saved === "claude_desktop" ||
        saved === "cursor"
      ) {
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
    useCodexRateLimitReset,
    switchAccount,
    deleteAccount,
    renameAccount,
    importFromFile,
    addClaudeFromCurrent,
    addClaudeDesktopFromCurrent,
    addCursorFromCurrent,
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
  const [pendingSwitchAccountId, setPendingSwitchAccountId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCompletingForceClose, setIsCompletingForceClose] = useState(false);
  const [isOpeningCodex, setIsOpeningCodex] = useState(false);
  const forceCloseInFlightRef = useRef(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [processInfoByTool, setProcessInfoByTool] = useState<
    Record<"codex" | "claude", ProcessInfo | null>
  >({ codex: null, claude: null });
  const [isRefreshing, setIsRefreshing] = useState(false);
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
  const [accountSearchQuery, setAccountSearchQuery] = useState("");
  const isAccountSearchEnabled = accounts.length >= ACCOUNT_SEARCH_THRESHOLD;
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

  const [discordPresenceEnabled, setDiscordPresenceEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    invokeBackend<boolean>("get_discord_presence_enabled")
      .then((enabled) => {
        if (!cancelled) setDiscordPresenceEnabled(enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleDiscordPresence = async () => {
    const next = !discordPresenceEnabled;
    setDiscordPresenceEnabled(next);
    try {
      await invokeBackend("set_discord_presence_enabled", { enabled: next });
    } catch {
      setDiscordPresenceEnabled(!next);
      toast.error("Failed to update Discord Rich Presence setting");
    }
  };

  const accountsRef = useRef(accounts);
  const autoWarmupAccountIdsRef = useRef(autoWarmupAccountIds);
  const autoWarmupLedgerRef = useRef(autoWarmupLedger);
  const autoWarmupRunningIdsRef = useRef(autoWarmupRunningIds);
  const autoWarmupRetryAfterRef = useRef<Record<string, number>>({});

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    if (!isAccountSearchEnabled && accountSearchQuery) {
      setAccountSearchQuery("");
    }
  }, [accountSearchQuery, isAccountSearchEnabled]);

  useEffect(() => {
    autoWarmupAccountIdsRef.current = autoWarmupAccountIds;
  }, [autoWarmupAccountIds]);

  useEffect(() => {
    autoWarmupRunningIdsRef.current = autoWarmupRunningIds;
  }, [autoWarmupRunningIds]);

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
      const isDark = resolveThemeDark(themeMode, !!mq?.matches);
      document.documentElement.classList.toggle("dark", isDark);
      void setWindowTheme(isDark ? "dark" : "light");
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
    const activeProcessInfo =
      latest &&
      (backendTarget.tool === "codex" || backendTarget.tool === "claude"
        ? latest[backendTarget.tool]
        : null);
    if (backendTarget.tool === "codex" && !latest) {
      toast.error("Could not check running Codex processes. Try again.");
      return;
    }
    if (activeProcessInfo && !activeProcessInfo.can_switch) {
      if (backendTarget.tool === "codex") {
        setPendingSwitchAccountId(accountId);
        setForceCloseConfirmOpen(true);
      }
      return;
    }

    try {
      setSwitchingId(accountId);
      await switchAccount(accountId);
    } catch (err) {
      console.error("Failed to switch account:", err);
      const codexProcessInfo =
        backendTarget.tool === "codex" ? (await checkProcesses())?.codex : null;
      if (codexProcessInfo && !codexProcessInfo.can_switch) {
        setPendingSwitchAccountId(accountId);
        setForceCloseConfirmOpen(true);
      } else {
        toast.error(
          err instanceof Error ? err.message : "Failed to switch account"
        );
      }
    } finally {
      setSwitchingId(null);
    }
  };

  const handleLogout = async () => {
    const latest = await checkProcesses();
    const activeProcessInfo =
      latest &&
      (backendTarget.tool === "codex" || backendTarget.tool === "claude"
        ? latest[backendTarget.tool]
        : null);
    if (activeProcessInfo && !activeProcessInfo.can_switch) {
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

  const checkCodexProcesses = useCallback(
    async () => (await checkProcesses())?.codex ?? null,
    [checkProcesses]
  );

  const {
    forceCloseConfirmOpen,
    setForceCloseConfirmOpen,
    isForceClosingCodex: isKillingCodex,
    closeCodexProcesses,
  } = useForceCloseCodexProcesses({
    processCount: processInfoByTool.codex?.count ?? 0,
    checkProcesses: checkCodexProcesses,
    showToast: showWarmupToast,
    formatError: formatWarmupError,
  });
  const isForceClosingCodex = isKillingCodex || isCompletingForceClose;
  const desktopReopen = useDesktopReopen(forceCloseConfirmOpen);
  const codexClose = useCodexClosePreference(forceCloseConfirmOpen);
  const saveDesktopReopenPreference = (value: DesktopReopenPreference) => {
    try {
      desktopReopen.savePreference(value);
    } catch (err) {
      showWarmupToast(`Could not save preference: ${formatWarmupError(err)}`, true);
    }
  };
  const saveCodexClosePreference = (value: CodexClosePreference) => {
    try {
      codexClose.savePreference(value);
    } catch (err) {
      showWarmupToast(`Could not save close preference: ${formatWarmupError(err)}`, true);
    }
  };

  const handleForceCloseConfirm = async () => {
    if (forceCloseInFlightRef.current || desktopReopen.checking) return;
    forceCloseInFlightRef.current = true;
    const accountId = pendingSwitchAccountId;
    const shouldReopen = desktopReopen.available && desktopReopen.reopen;
    setIsCompletingForceClose(true);
    try {
      try {
        desktopReopen.rememberSelection();
      } catch (err) {
        showWarmupToast(`Could not save preference: ${formatWarmupError(err)}`, true);
      }
      try {
        codexClose.rememberSelection();
      } catch (err) {
        showWarmupToast(`Could not save close preference: ${formatWarmupError(err)}`, true);
      }
      const result = await closeCodexProcesses(shouldReopen, codexClose.forceClose);
      if (!result?.processInfo?.can_switch) return;

      await finishForceClose(
        { canSwitch: true, reopenToken: result.reopenToken },
        accountId ? async () => {
          setSwitchingId(accountId);
          await switchAccount(accountId);
          showWarmupToast(`Switched account after ${codexClose.forceClose ? "force closing" : "closing"} Codex.`);
        } : null,
        async (token) => {
          try {
            await invokeBackend("reopen_closed_codex_desktop", { token });
            showWarmupToast(accountId ? "Account switched. Codex desktop reopened." : "Codex desktop reopened.");
          } catch (err) {
            showWarmupToast(`Codex closed${accountId ? " and account switched" : ""}, but reopening failed: ${formatWarmupError(err)}`, true);
          }
        },
      );
      if (shouldReopen && !result.reopenToken) {
        showWarmupToast("No closed desktop app could be identified for reopening. Open Codex manually.", true);
      }
    } catch (err) {
      console.error("Failed to switch account after closing Codex:", err);
      showWarmupToast(`Switch failed after closing Codex: ${formatWarmupError(err)}`, true);
    } finally {
      setPendingSwitchAccountId(null);
      setSwitchingId(null);
      setIsCompletingForceClose(false);
      forceCloseInFlightRef.current = false;
      void checkProcesses();
    }
  };

  const handleOpenCodexApp = async () => {
    try {
      setIsOpeningCodex(true);
      await invokeBackend("open_codex_app");
      showWarmupToast("Codex app opened.");
      setTimeout(() => {
        void checkProcesses();
      }, 1500);
    } catch (err) {
      console.error("Failed to open Codex app:", err);
      showWarmupToast(`Open Codex failed: ${formatWarmupError(err)}`, true);
    } finally {
      setIsOpeningCodex(false);
    }
  };

  const markSuccessfulWarmup = useCallback(
    (accountId: string, timestamp = Date.now(), window?: AutoWarmupWindow) => {
      delete autoWarmupRetryAfterRef.current[accountId];
      setAutoWarmupLedger((prev) => ({
        ...prev,
        [accountId]: {
          lastSuccessfulWarmupAt: timestamp,
          ...(window
            ? {
                lastAutoWindowKey: getAutoWarmupWindowKey(window),
                lastAutoWindowKind: window.kind,
              }
            : {}),
        },
      }));
    },
    []
  );

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

  const handleUseRateLimitReset = async (accountId: string) => {
    try {
      const result = await useCodexRateLimitReset(accountId);
      switch (result.outcome) {
        case "reset":
          toast.success("Usage reset.");
          break;
        case "already_redeemed":
          toast.success("Usage reset already applied.");
          break;
        case "nothing_to_reset":
          toast.info("Your usage does not need a reset right now.");
          break;
        case "no_credit":
          toast.warning("No usage limit resets are available.");
          break;
        default:
          console.warn("Unknown usage reset outcome:", result.outcome);
          toast("Usage reset request completed.");
          break;
      }
    } catch (err) {
      console.error("Failed to use rate limit reset:", err);
      toast.error(
        err instanceof Error ? err.message : "Failed to use usage reset"
      );
      throw err;
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

  const getDueAutoWarmupForAccount = useCallback(
    (accountId: string, usage: UsageInfo | undefined) => {
      return getDueAutoWarmupWindow(usage, autoWarmupLedgerRef.current[accountId]);
    },
    []
  );

  const formatWindowDuration = (minutes: number | null | undefined): string => {
    if (!minutes || minutes <= 0) return "";
    if (minutes < 24 * 60) {
      return `${Math.ceil(minutes / 60)}h`;
    }
    return `${Math.ceil(minutes / (24 * 60))}d`;
  };

  const getAutoWarmupLabel = useCallback(
    (
      usage: UsageInfo | undefined,
      isEnabled: boolean,
      isRunning: boolean
    ) => {
      if (isRunning) return "Warming...";
      if (!isEnabled) return "Auto: off";
      if (!usage || usage.error) return "Auto: on";

      const windowKind = getAutoWarmupWindowKind(usage);
      if (windowKind === "session" && isLimitFull(usage.secondary_used_percent)) {
        const weeklyDuration = formatWindowDuration(usage.secondary_window_minutes);
        return weeklyDuration ? `Waiting ${weeklyDuration}` : "Waiting reset";
      }
      if (windowKind === "session") {
        return `Auto: ${formatWindowDuration(usage.primary_window_minutes) || "5h"}`;
      }
      if (windowKind === "weekly") {
        return `Auto: ${formatWindowDuration(usage.secondary_window_minutes) || "7d"}`;
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

        const window = getDueAutoWarmupForAccount(accountId, freshUsage);
        if (!window) return;

        await warmupAccount(accountId);
        markSuccessfulWarmup(accountId, Date.now(), window);
        const modeLabel = window.kind === "session" ? "5h" : "weekly";
        showWarmupToast(`Auto ${modeLabel} warm-up sent for ${accountName}`);
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
      getDueAutoWarmupForAccount,
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

        if (!getDueAutoWarmupForAccount(account.id, account.usage)) continue;

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
    getDueAutoWarmupForAccount,
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

  const activeAccount = accounts.find((a) => a.is_active);
  const otherAccounts = accounts.filter((a) => !a.is_active);
  const pendingSwitchAccount = useMemo(
    () => accounts.find((account) => account.id === pendingSwitchAccountId),
    [accounts, pendingSwitchAccountId]
  );
  const closeConfirmLabel = pendingSwitchAccount
    ? "Close and switch account"
    : "Close Codex";
  const codexProcessInfo = processInfoByTool.codex;
  const claudeProcessInfo = processInfoByTool.claude;
  const hasRunningCodex = !!codexProcessInfo && codexProcessInfo.count > 0;
  const hasRunningClaude = !!claudeProcessInfo && claudeProcessInfo.count > 0;
  const usageEnabled = true;
  const warmupEnabled =
    activeTool === "codex" ||
    activeTool === "claude_code" ||
    activeTool === "claude_desktop";
  const hasRunningActiveTool =
    activeTool === "codex"
      ? hasRunningCodex
      : activeTool === "claude_code" || activeTool === "claude_desktop"
        ? hasRunningClaude
        : false;
  const activeToolLabel =
    activeTool === "codex"
      ? "Codex"
      : activeTool === "claude_code"
        ? "Claude Code"
        : activeTool === "claude_desktop"
          ? "Claude Desktop"
          : "Cursor";
  const switchDisabledLabel =
    activeTool === "codex" ? "Codex Running" : "Claude Running";
  const switchDisabledTooltip =
    activeTool === "codex"
      ? "Close all Codex processes first"
      : "Close all Claude processes first";
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
          getResetDeadline(getPreferredResetsAt(a.usage)) -
          getResetDeadline(getPreferredResetsAt(b.usage));
        if (deadlineDiff !== 0) return deadlineDiff;

        const remainingDiff =
          getRemainingPercent(getPreferredUsedPercent(b.usage)) -
          getRemainingPercent(getPreferredUsedPercent(a.usage));
        if (remainingDiff !== 0) return remainingDiff;

        return a.name.localeCompare(b.name);
      }

      if (otherAccountsSort === "deadline_asc" || otherAccountsSort === "deadline_desc") {
        const deadlineDiff =
          getResetDeadline(getPreferredResetsAt(a.usage)) -
          getResetDeadline(getPreferredResetsAt(b.usage));
        if (deadlineDiff !== 0) {
          return otherAccountsSort === "deadline_asc" ? deadlineDiff : -deadlineDiff;
        }
        const remainingDiff =
          getRemainingPercent(getPreferredUsedPercent(b.usage)) -
          getRemainingPercent(getPreferredUsedPercent(a.usage));
        if (remainingDiff !== 0) return remainingDiff;
        return a.name.localeCompare(b.name);
      }

      const remainingDiff =
        getRemainingPercent(getPreferredUsedPercent(b.usage)) -
        getRemainingPercent(getPreferredUsedPercent(a.usage));
      if (otherAccountsSort === "remaining_desc" && remainingDiff !== 0) {
        return remainingDiff;
      }
      if (otherAccountsSort === "remaining_asc" && remainingDiff !== 0) {
        return -remainingDiff;
      }
      const deadlineDiff =
        getResetDeadline(getPreferredResetsAt(a.usage)) -
        getResetDeadline(getPreferredResetsAt(b.usage));
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

  const normalizedAccountSearchQuery = isAccountSearchEnabled
    ? accountSearchQuery.trim().toLowerCase()
    : "";
  const hasMatchingActiveAccount =
    activeAccount !== undefined &&
    matchesAccountSearch(activeAccount, normalizedAccountSearchQuery);
  const visibleOtherAccounts = useMemo(
    () =>
      sortedOtherAccounts.filter((account) =>
        matchesAccountSearch(account, normalizedAccountSearchQuery)
      ),
    [normalizedAccountSearchQuery, sortedOtherAccounts]
  );
  const hasNoMatchingAccounts =
    normalizedAccountSearchQuery.length > 0 &&
    !hasMatchingActiveAccount &&
    visibleOtherAccounts.length === 0;

  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="bg-background sticky top-0 z-40 border-b">

        <div className="mx-auto max-w-5xl px-6 py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_max-content] md:items-center md:gap-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
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
                  {codexProcessInfo && hasRunningCodex && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        setPendingSwitchAccountId(null);
                        setForceCloseConfirmOpen(true);
                      }}
                      disabled={isForceClosingCodex}
                    >
                      Close
                    </Button>
                  )}
                  {activeTool === "codex" &&
                    isTauriRuntime() &&
                    codexProcessInfo &&
                    !hasRunningCodex && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleOpenCodexApp}
                        disabled={isOpeningCodex || isCompletingForceClose || switchingId !== null}
                      >
                        <Monitor data-icon="inline-start" />
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
                  <Button
                    variant={discordPresenceEnabled ? "success" : "outline"}
                    size="icon"
                    onClick={toggleDiscordPresence}
                    aria-label={
                      discordPresenceEnabled
                        ? "Disable Discord Rich Presence"
                        : "Enable Discord Rich Presence"
                    }
                  >
                    <Gamepad2 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {discordPresenceEnabled
                    ? "Disable Discord Rich Presence"
                    : "Enable Discord Rich Presence"}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setIsSettingsOpen(true)}
                    aria-label="Settings"
                  >
                    <Settings />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Settings</TooltipContent>
              </Tooltip>
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
              <TabsTrigger value="codex" disabled={isRefreshing}>Codex</TabsTrigger>
              <TabsTrigger value="claude_code" disabled={isRefreshing}>
                Claude Code
              </TabsTrigger>
              <TabsTrigger value="claude_desktop" disabled={isRefreshing}>
                Claude Desktop
              </TabsTrigger>
              <TabsTrigger value="cursor" disabled={isRefreshing}>
                Cursor
              </TabsTrigger>
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
                    : activeTool === "claude_desktop"
                      ? "Claude Desktop"
                      : "Cursor"}{" "}
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
            {isAccountSearchEnabled && (
              <div className="relative max-w-lg">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-400 dark:text-gray-500">
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" strokeLinecap="round" />
                  </svg>
                </span>
                <input
                  type="search"
                  value={accountSearchQuery}
                  onChange={(event) => setAccountSearchQuery(event.target.value)}
                  placeholder="Search accounts by name or email"
                  aria-label="Search accounts"
                  className="w-full rounded-xl border border-gray-300 bg-white py-2.5 pl-10 pr-10 text-sm text-gray-900 shadow-sm transition-colors placeholder:text-gray-400 focus:border-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-gray-600 dark:focus:ring-gray-800"
                />
                {accountSearchQuery.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setAccountSearchQuery("")}
                    aria-label="Clear account search"
                    className="absolute inset-y-0 right-2 flex items-center px-2 text-gray-400 transition-colors hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200"
                  >
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path d="m8 8 8 8M16 8l-8 8" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
            )}

            {hasNoMatchingAccounts && (
              <div className="rounded-2xl border border-dashed border-gray-300 px-6 py-12 text-center dark:border-gray-700">
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  No matching accounts
                </h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Try a different account name or email address.
                </p>
              </div>
            )}

            {activeAccount &&
              matchesAccountSearch(activeAccount, normalizedAccountSearchQuery) && (
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
                  onUseRateLimitReset={() =>
                    handleUseRateLimitReset(activeAccount.id)
                  }
                  onRename={(newName) => renameAccount(activeAccount.id, newName)}
                  switching={switchingId === activeAccount.id}
                  switchDisabled={hasRunningActiveTool && activeTool !== "codex"}
                  codexRunning={activeTool === "codex" && hasRunningCodex}
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

            {visibleOtherAccounts.length > 0 && (
              <section>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="text-muted-foreground text-sm font-medium uppercase tracking-wider">
                    Other Accounts ({
                      normalizedAccountSearchQuery
                        ? `${visibleOtherAccounts.length} of ${otherAccounts.length}`
                        : otherAccounts.length
                    })
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
                  {visibleOtherAccounts.map((account) => (
                    <AccountCard
                      key={account.id}
                      account={account}
                      onSwitch={() => handleSwitch(account.id)}
                      onWarmup={() => handleWarmupAccount(account.id, account.name)}
                      onDelete={() => handleDelete(account.id)}
                      onRefresh={() =>
                        refreshSingleUsage(account.id, { refreshMetadata: true })
                      }
                      onUseRateLimitReset={() =>
                        handleUseRateLimitReset(account.id)
                      }
                      onRename={(newName) => renameAccount(account.id, newName)}
                      switching={switchingId === account.id}
                      switchDisabled={hasRunningActiveTool && activeTool !== "codex"}
                      codexRunning={activeTool === "codex" && hasRunningCodex}
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
            <AppFooter />
          </section>
        )}
      </main>

      <AddAccountModal
        isOpen={isAddModalOpen}
        activeTool={activeTool}
        onClose={() => setIsAddModalOpen(false)}
        onImportFile={importFromFile}
        onAddClaudeFromCurrent={addClaudeFromCurrent}
        onAddClaudeDesktopFromCurrent={addClaudeDesktopFromCurrent}
        onAddCursorFromCurrent={addCursorFromCurrent}
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

      <SettingsModal
        open={isSettingsOpen}
        reopenPreference={desktopReopen.preference}
        onReopenPreferenceChange={saveDesktopReopenPreference}
        closePreference={codexClose.preference}
        onClosePreferenceChange={saveCodexClosePreference}
        onClose={() => setIsSettingsOpen(false)}
      />

      <AlertDialog
        open={forceCloseConfirmOpen}
        onOpenChange={(open) => {
          if (open || isForceClosingCodex) return;
          setPendingSwitchAccountId(null);
          setForceCloseConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close running Codex processes?</AlertDialogTitle>
            <AlertDialogDescription>
              This will {codexClose.forceClose ? "force close" : "gracefully close"}{" "}
              {codexProcessInfo?.count ?? 0} Codex process
              {(codexProcessInfo?.count ?? 0) === 1 ? "" : "es"} that currently{" "}
              {(codexProcessInfo?.count ?? 0) === 1 ? "blocks" : "block"} account switching.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="bg-muted flex flex-col gap-2 rounded-lg border p-3">
            {codexClose.preference !== "ask" ? (
              <p className="text-muted-foreground text-sm">
                Codex will {codexClose.forceClose ? "be force closed" : "close gracefully"}. You can change this in Settings.
              </p>
            ) : (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={codexClose.forceClose}
                    onChange={(event) => codexClose.setForceClose(event.target.checked)}
                    disabled={isForceClosingCodex}
                    className="accent-destructive size-4"
                  />
                  Force close Codex
                </label>
                <label className="text-muted-foreground flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={codexClose.remember}
                    onChange={(event) => codexClose.setRemember(event.target.checked)}
                    disabled={isForceClosingCodex}
                    className="accent-primary size-4"
                  />
                  Remember this selection
                </label>
                <p className="text-muted-foreground text-xs">
                  {codexClose.forceClose
                    ? "Stops Codex immediately. Unsaved work may be lost."
                    : "Asks Codex to quit normally so it can finish cleanup."}
                </p>
              </>
            )}
          </div>
          {pendingSwitchAccount && (
            <p className="text-muted-foreground text-sm">
              After closing Codex, AI Switcher will switch to{" "}
              <span className="text-foreground font-medium">{pendingSwitchAccount.name}</span>.
            </p>
          )}
          <div className="bg-muted flex flex-col gap-2 rounded-lg p-3">
            {desktopReopen.checking ? (
              <p className="text-muted-foreground text-sm">Checking for a desktop app to reopen...</p>
            ) : desktopReopen.available && desktopReopen.preference !== "ask" ? (
              <p className="text-muted-foreground text-sm">
                {desktopReopen.preference === "always"
                  ? "Codex desktop will reopen automatically."
                  : "Codex desktop will stay closed."}{" "}
                You can change this in Settings.
              </p>
            ) : desktopReopen.available ? (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={desktopReopen.reopen}
                    onChange={(event) => desktopReopen.setReopen(event.target.checked)}
                    disabled={isForceClosingCodex}
                    className="accent-primary size-4"
                  />
                  Reopen Codex desktop after close
                </label>
                <label className="text-muted-foreground flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={desktopReopen.remember}
                    onChange={(event) => desktopReopen.setRemember(event.target.checked)}
                    disabled={isForceClosingCodex}
                    className="accent-primary size-4"
                  />
                  Remember this selection
                </label>
                <p className="text-muted-foreground text-xs">
                  You can change this later in Settings. Terminal and IDE sessions will not reopen.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">
                No supported desktop app could be identified for reopening. Codex will only be closed.
              </p>
            )}
          </div>
          {codexClose.forceClose && (
            <p className="text-destructive text-sm">Unsaved Codex work may be lost.</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isForceClosingCodex}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={codexClose.forceClose ? "destructive" : "default"}
              disabled={isForceClosingCodex || desktopReopen.checking}
              onClick={(event) => {
                event.preventDefault();
                void handleForceCloseConfirm();
              }}
            >
              {isForceClosingCodex
                ? codexClose.forceClose
                  ? "Force closing..."
                  : "Closing..."
                : closeConfirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Toaster richColors position="bottom-center" />
    </div>
  );
}

export default App;
