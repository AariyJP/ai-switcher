import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Bot,
  ChevronDown,
  Eye,
  EyeOff,
  Loader2,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Sun,
  User,
  Zap,
} from "lucide-react";
import { toast, Toaster } from "sonner";
import { useAccounts } from "./hooks/useAccounts";
import { AccountCard, AddAccountModal, TitleBar, UpdateChecker } from "./components";
import type { ProcessInfo, ToolKind } from "./types";
import {
  exportFullBackupFile,
  importFullBackupFile,
  invokeBackend,
} from "./lib/platform";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import "./App.css";

const THEME_STORAGE_KEY = "codex-switcher-theme";
const ACTIVE_TOOL_STORAGE_KEY = "ac-switcher-active-tool";
type ThemeMode = "light" | "dark" | "system";
type ActiveTool = "codex" | "claude";
type SortKey =
  | "deadline_asc"
  | "deadline_desc"
  | "remaining_desc"
  | "remaining_asc"
  | "subscription_asc"
  | "subscription_desc";

function App() {
  const [activeTool, setActiveTool] = useState<ActiveTool>(() => {
    if (typeof window === "undefined") return "codex";
    try {
      const saved = window.localStorage.getItem(ACTIVE_TOOL_STORAGE_KEY);
      if (saved === "codex" || saved === "claude") return saved;
      return "codex";
    } catch {
      return "codex";
    }
  });

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
    exportAccountsSlimText,
    importAccountsSlimText,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    startClaudeOAuthLogin,
    completeClaudeOAuthLogin,
    cancelClaudeOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  } = useAccounts(activeTool);

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [configModalMode, setConfigModalMode] = useState<"slim_export" | "slim_import">(
    "slim_export"
  );
  const [configPayload, setConfigPayload] = useState("");
  const [configModalError, setConfigModalError] = useState<string | null>(null);
  const [configCopied, setConfigCopied] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [processInfoByTool, setProcessInfoByTool] = useState<
    Record<ToolKind, ProcessInfo | null>
  >({ codex: null, claude: null });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExportingSlim, setIsExportingSlim] = useState(false);
  const [isImportingSlim, setIsImportingSlim] = useState(false);
  const [isExportingFull, setIsExportingFull] = useState(false);
  const [isImportingFull, setIsImportingFull] = useState(false);
  const [isWarmingAll, setIsWarmingAll] = useState(false);
  const [warmingUpId, setWarmingUpId] = useState<string | null>(null);
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
    if (latest && !latest[activeTool].can_switch) {
      return;
    }

    try {
      setSwitchingId(accountId);
      await switchAccount(accountId);
    } catch (err) {
      console.error("Failed to switch account:", err);
    } finally {
      setSwitchingId(null);
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

  const formatWarmupError = (err: unknown) => {
    if (!err) return "Unknown error";
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  };

  const handleWarmupAccount = async (accountId: string, accountName: string) => {
    try {
      setWarmingUpId(accountId);
      await warmupAccount(accountId);
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

      if (summary.failed_account_ids.length === 0) {
        toast.success(
          `Warm-up sent for all ${summary.warmed_accounts} account${
            summary.warmed_accounts === 1 ? "" : "s"
          }`
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
  const codexProcessInfo = processInfoByTool.codex;
  const claudeProcessInfo = processInfoByTool.claude;
  const hasRunningCodex = !!codexProcessInfo && codexProcessInfo.count > 0;
  const hasRunningClaude = !!claudeProcessInfo && claudeProcessInfo.count > 0;
  const usageEnabled = true;
  const warmupEnabled = activeTool === "codex";
  const hasRunningActiveTool = activeTool === "codex" ? hasRunningCodex : hasRunningClaude;
  const switchDisabledLabel = activeTool === "codex" ? "Codex Running" : "Claude Running";
  const switchDisabledTooltip =
    activeTool === "codex" ? "Close all Codex processes first" : "Close all Claude processes first";

  const sortedOtherAccounts = useMemo(() => {
    if (activeTool === "claude") {
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
                    <Badge
                      variant="outline"
                      className={cn(
                        hasRunningCodex
                          ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                          : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                      )}
                    >
                      <span
                        className={cn(
                          "inline-block size-1.5 rounded-full",
                          hasRunningCodex ? "bg-amber-500" : "bg-emerald-500"
                        )}
                      />
                      {codexProcessInfo.count} Codex running
                    </Badge>
                  )}
                  {claudeProcessInfo && (
                    <Badge
                      variant="outline"
                      className={cn(
                        hasRunningClaude
                          ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                          : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                      )}
                    >
                      <span
                        className={cn(
                          "inline-block size-1.5 rounded-full",
                          hasRunningClaude ? "bg-amber-500" : "bg-emerald-500"
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
                  <Button variant="outline" size="icon" onClick={toggleMaskAll}>
                    {allMasked ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
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
                  >
                    <RefreshCw className={cn("size-4", isRefreshing && "animate-spin")} />
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
                    >
                      <Zap className={cn("size-4", isWarmingAll && "animate-pulse")} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Send minimal traffic using all accounts</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" onClick={cycleTheme}>
                    <ThemeIcon className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{themeTitle}</TooltipContent>
              </Tooltip>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button>
                    Account
                    <ChevronDown className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onSelect={() => setIsAddModalOpen(true)}>
                    <Plus className="size-4" />
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
              <TabsTrigger value="claude">Claude</TabsTrigger>
            </TabsList>
          </div>
        </Tabs>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {loading && accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="text-foreground mb-4 size-10 animate-spin" />
            <p className="text-muted-foreground">Loading accounts...</p>
          </div>
        ) : error ? (
          <div className="py-20 text-center">
            <div className="text-destructive mb-2">Failed to load accounts</div>
            <p className="text-muted-foreground text-sm">{error}</p>
          </div>
        ) : accounts.length === 0 ? (
          <div className="py-20 text-center">
            <div className="bg-muted mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl">
              {activeTool === "claude" ? (
                <Bot className="text-muted-foreground size-8" />
              ) : (
                <User className="text-muted-foreground size-8" />
              )}
            </div>
            <h2 className="text-foreground mb-2 text-xl font-semibold">No accounts yet</h2>
            <p className="text-muted-foreground mb-6">
              Add your first {activeTool === "claude" ? "Claude" : "Codex"} account to get started
            </p>
            <Button onClick={() => setIsAddModalOpen(true)}>Add Account</Button>
          </div>
        ) : (
          <div className="space-y-8">
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
                  warmingUp={isWarmingAll || warmingUpId === activeAccount.id}
                  masked={maskedAccounts.has(activeAccount.id)}
                  usageEnabled={usageEnabled}
                  warmupEnabled={warmupEnabled}
                  onToggleMask={() => toggleMask(activeAccount.id)}
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
                      warmingUp={isWarmingAll || warmingUpId === account.id}
                      masked={maskedAccounts.has(account.id)}
                      usageEnabled={usageEnabled}
                      warmupEnabled={warmupEnabled}
                      onToggleMask={() => toggleMask(account.id)}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      <AddAccountModal
        isOpen={isAddModalOpen}
        tool={activeTool}
        onClose={() => setIsAddModalOpen(false)}
        onImportFile={importFromFile}
        onAddClaudeFromCurrent={addClaudeFromCurrent}
        onStartOAuth={startOAuthLogin}
        onCompleteOAuth={completeOAuthLogin}
        onCancelOAuth={cancelOAuthLogin}
        onStartClaudeOAuth={startClaudeOAuthLogin}
        onCompleteClaudeOAuth={completeClaudeOAuthLogin}
        onCancelClaudeOAuth={cancelClaudeOAuthLogin}
      />

      <Dialog
        open={isConfigModalOpen}
        onOpenChange={(open) => setIsConfigModalOpen(open)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {configModalMode === "slim_export" ? "Export Slim Text" : "Import Slim Text"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {configModalMode === "slim_import" ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
                Existing accounts are kept. Only missing accounts are imported.
              </p>
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
              <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border p-3 text-sm">
                {configModalError}
              </div>
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

      <UpdateChecker />
      <Toaster richColors position="bottom-center" />
    </div>
  );
}

export default App;
