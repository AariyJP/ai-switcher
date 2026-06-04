import { useState, useEffect, useCallback, useRef } from "react";
import type {
  AccountInfo,
  AuthMode,
  UsageInfo,
  AccountWithUsage,
  WarmupSummary,
  ImportAccountsSummary,
  ToolKind,
} from "../types";
import { invokeBackend, type FileSource } from "../lib/platform";

export function useAccounts(tool: ToolKind = "codex", authMode?: AuthMode) {
  const [accounts, setAccounts] = useState<AccountWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accountsRef = useRef<AccountWithUsage[]>([]);
  const maxConcurrentUsageRequests = 10;

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  const fetchedToolsRef = useRef<Set<string>>(new Set());
  const usageCacheRef = useRef<Map<string, UsageInfo>>(new Map());
  const toolKey = `${tool}:${authMode ?? ""}`;

  const buildUsageError = useCallback(
    (accountId: string, message: string, planType: string | null): UsageInfo => ({
      account_id: accountId,
      plan_type: planType,
      primary_used_percent: null,
      primary_window_minutes: null,
      primary_resets_at: null,
      secondary_used_percent: null,
      secondary_window_minutes: null,
      secondary_resets_at: null,
      has_credits: null,
      unlimited_credits: null,
      credits_balance: null,
      error: message,
    }),
    []
  );

  const runWithConcurrency = useCallback(
    async <T,>(
      items: T[],
      worker: (item: T) => Promise<void>,
      concurrency: number
    ) => {
      if (items.length === 0) return;
      const limit = Math.min(Math.max(concurrency, 1), items.length);
      let index = 0;
      const runners = Array.from({ length: limit }, async () => {
        while (true) {
          const current = index++;
          if (current >= items.length) return;
          await worker(items[current]);
        }
      });
      await Promise.allSettled(runners);
    },
    []
  );

  const loadAccounts = useCallback(async (preserveUsage = false) => {
    try {
      setLoading(true);
      setError(null);
      const accountList = await invokeBackend<AccountInfo[]>("list_accounts", {
        tool,
        authMode,
      });

      setAccounts((prev) => {
        const prevMap = preserveUsage
          ? new Map(prev.map((a) => [a.id, { usage: a.usage, usageLoading: a.usageLoading }]))
          : null;
        return accountList.map((a) => {
          const fromPrev = prevMap?.get(a.id);
          const cached = usageCacheRef.current.get(a.id);
          return {
            ...a,
            usage: fromPrev?.usage ?? cached,
            usageLoading: fromPrev?.usageLoading ?? false,
          };
        });
      });
      return accountList;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, [tool, authMode]);

  const refreshUsage = useCallback(
    async (
      accountList?: AccountInfo[] | AccountWithUsage[],
      options?: { refreshMetadata?: boolean }
    ) => {
      try {
        let list = accountList ?? accountsRef.current;
        if (list.length === 0 || authMode === "claude_desktop") {
          return;
        }

        if (options?.refreshMetadata && tool === "codex") {
          await runWithConcurrency(
            list,
            async (account) => {
              await invokeBackend<AccountInfo>("refresh_account_metadata", {
                accountId: account.id,
              });
            },
            maxConcurrentUsageRequests
          );

          list = await loadAccounts(true);
        }

        const accountIds = list.map((account) => account.id);
        const accountIdSet = new Set(accountIds);
        const usageResults = new Map<string, UsageInfo>();

        setAccounts((prev) =>
          prev.map((account) =>
            accountIdSet.has(account.id)
              ? { ...account, usageLoading: true }
              : account
          )
        );

        await runWithConcurrency(
          list,
          async (account) => {
            try {
              const usage = await invokeBackend<UsageInfo>("get_usage", {
                accountId: account.id,
              });
              usageResults.set(account.id, usage);
              usageCacheRef.current.set(account.id, usage);
            } catch (err) {
              console.error("Failed to refresh usage:", err);
              const message = err instanceof Error ? err.message : String(err);
              const errInfo = buildUsageError(account.id, message, account.plan_type ?? null);
              usageResults.set(account.id, errInfo);
              usageCacheRef.current.set(account.id, errInfo);
            }
          },
          maxConcurrentUsageRequests
        );

        setAccounts((prev) =>
          prev.map((account) => {
            const usage = usageResults.get(account.id);
            if (!usage) return account;
            return {
              ...account,
              usage,
              usageLoading: false,
            };
          })
        );
      } catch (err) {
        console.error("Failed to refresh usage:", err);
        throw err;
      }
    },
    [buildUsageError, loadAccounts, maxConcurrentUsageRequests, runWithConcurrency, tool, authMode]
  );

  const refreshSingleUsage = useCallback(async (
    accountId: string,
    options?: { refreshMetadata?: boolean }
  ) => {
    try {
      if (authMode === "claude_desktop") {
        return;
      }

      if (options?.refreshMetadata && tool === "codex") {
        await invokeBackend<AccountInfo>("refresh_account_metadata", { accountId });
        await loadAccounts(true);
      }

      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId ? { ...a, usageLoading: true } : a
        )
      );
      const usage = await invokeBackend<UsageInfo>("get_usage", { accountId });
      usageCacheRef.current.set(accountId, usage);
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId ? { ...a, usage, usageLoading: false } : a
        )
      );
      return usage;
    } catch (err) {
      console.error("Failed to refresh single usage:", err);
      const message = err instanceof Error ? err.message : String(err);
      const account = accountsRef.current.find((a) => a.id === accountId);
      const errInfo = buildUsageError(accountId, message, account?.plan_type ?? null);
      usageCacheRef.current.set(accountId, errInfo);
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? { ...a, usage: errInfo, usageLoading: false }
            : a
        )
      );
      throw err;
    }
  }, [buildUsageError, loadAccounts, tool, authMode]);

  const warmupAccount = useCallback(async (accountId: string) => {
    try {
      if (tool !== "codex") {
        return;
      }
      await invokeBackend("warmup_account", { accountId });
    } catch (err) {
      console.error("Failed to warm up account:", err);
      throw err;
    }
  }, [tool]);

  const warmupAllAccounts = useCallback(async () => {
    try {
      if (tool !== "codex") {
        return {
          total_accounts: 0,
          warmed_accounts: 0,
          failed_account_ids: [],
        };
      }
      return await invokeBackend<WarmupSummary>("warmup_all_accounts");
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      throw err;
    }
  }, [tool]);

  const switchAccount = useCallback(
    async (accountId: string) => {
      try {
        await invokeBackend("switch_account", { accountId });
        await loadAccounts(true); // Preserve usage data
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const deleteAccount = useCallback(
    async (accountId: string) => {
      try {
        await invokeBackend("delete_account", { accountId });
        usageCacheRef.current.delete(accountId);
        await loadAccounts();
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const renameAccount = useCallback(
    async (accountId: string, newName: string) => {
      try {
        await invokeBackend("rename_account", { accountId, newName });
        await loadAccounts(true); // Preserve usage data
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const importFromFile = useCallback(
    async (source: FileSource, name: string) => {
      try {
        if (tool !== "codex") {
          throw new Error("File import is only available for Codex accounts");
        }

        if (typeof source === "string") {
          await invokeBackend<AccountInfo>("add_account_from_file", { path: source, name });
        } else {
          const contents = await source.text();
          await invokeBackend<AccountInfo>("add_account_from_auth_json_text", {
            name,
            contents,
          });
        }
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage, tool]
  );

  const addClaudeFromCurrent = useCallback(
    async (name: string) => {
      try {
        if (tool !== "claude" || authMode !== "claude_code") {
          throw new Error("Claude Code import is only available on the Claude Code tab");
        }

        await invokeBackend<AccountInfo>("add_claude_account_from_current", { name });
        const accountList = await loadAccounts();
        fetchedToolsRef.current.add(toolKey);
        await refreshUsage(accountList);
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage, tool, authMode, toolKey]
  );

  const addClaudeDesktopFromCurrent = useCallback(
    async (name: string) => {
      try {
        if (tool !== "claude" || authMode !== "claude_desktop") {
          throw new Error("Claude Desktop import is only available on the Claude tab");
        }

        await invokeBackend<AccountInfo>("add_claude_desktop_account_from_current", { name });
        const accountList = await loadAccounts();
        fetchedToolsRef.current.add(toolKey);
        await refreshUsage(accountList);
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage, tool, authMode, toolKey]
  );

  const startOAuthLogin = useCallback(async (accountName: string) => {
    try {
      const info = await invokeBackend<{ auth_url: string; callback_port: number }>(
        "start_login",
        { accountName }
      );
      return info;
    } catch (err) {
      throw err;
    }
  }, []);

  const completeOAuthLogin = useCallback(async () => {
    try {
      const account = await invokeBackend<AccountInfo>("complete_login");
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
      return account;
    } catch (err) {
      throw err;
    }
  }, [loadAccounts, refreshUsage]);

  const exportAccountsSlimText = useCallback(async () => {
    try {
      return await invokeBackend<string>("export_accounts_slim_text");
    } catch (err) {
      throw err;
    }
  }, []);

  const importAccountsSlimText = useCallback(
    async (payload: string) => {
      try {
        const summary = await invokeBackend<ImportAccountsSummary>("import_accounts_slim_text", {
          payload,
        });
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
        return summary;
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage]
  );

  const exportAccountsFullEncryptedFile = useCallback(
    async (path: string) => {
      try {
        await invokeBackend("export_accounts_full_encrypted_file", { path });
      } catch (err) {
        throw err;
      }
    },
    []
  );

  const importAccountsFullEncryptedFile = useCallback(
    async (path: string) => {
      try {
        const summary = await invokeBackend<ImportAccountsSummary>(
          "import_accounts_full_encrypted_file",
          { path }
        );
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
        return summary;
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage]
  );

  const cancelOAuthLogin = useCallback(async () => {
    try {
      await invokeBackend("cancel_login");
    } catch (err) {
      console.error("Failed to cancel login:", err);
    }
  }, []);

  const startClaudeOAuthLogin = useCallback(async (accountName: string) => {
    try {
      const info = await invokeBackend<{ auth_url: string; callback_port: number }>(
        "start_claude_login",
        { accountName }
      );
      return info;
    } catch (err) {
      throw err;
    }
  }, []);

  const completeClaudeOAuthLogin = useCallback(async () => {
    try {
      const account = await invokeBackend<AccountInfo>("complete_claude_login");
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
      return account;
    } catch (err) {
      throw err;
    }
  }, [loadAccounts, refreshUsage]);

  const cancelClaudeOAuthLogin = useCallback(async () => {
    try {
      await invokeBackend("cancel_claude_login");
    } catch (err) {
      console.error("Failed to cancel Claude login:", err);
    }
  }, []);

  const logoutCurrent = useCallback(async () => {
    const command =
      tool === "codex"
        ? "codex_logout"
        : authMode === "claude_desktop"
          ? "claude_desktop_logout"
          : "claude_code_logout";
    try {
      await invokeBackend(command);
      await loadAccounts(true);
    } catch (err) {
      throw err;
    }
  }, [loadAccounts, tool, authMode]);

  const loadMaskedAccountIds = useCallback(async () => {
    try {
      return await invokeBackend<string[]>("get_masked_account_ids");
    } catch (err) {
      console.error("Failed to load masked account IDs:", err);
      return [];
    }
  }, []);

  const saveMaskedAccountIds = useCallback(async (ids: string[]) => {
    try {
      await invokeBackend("set_masked_account_ids", { ids });
    } catch (err) {
      console.error("Failed to save masked account IDs:", err);
    }
  }, []);

  useEffect(() => {
    setAccounts([]);
    loadAccounts().then((accountList) => {
      if (fetchedToolsRef.current.has(toolKey)) {
        return;
      }
      if (accountList.length === 0) {
        return;
      }
      fetchedToolsRef.current.add(toolKey);
      refreshUsage(accountList);
    });
  }, [loadAccounts, refreshUsage, toolKey]);

  return {
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
    exportAccountsFullEncryptedFile,
    importAccountsFullEncryptedFile,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    startClaudeOAuthLogin,
    completeClaudeOAuthLogin,
    cancelClaudeOAuthLogin,
    logoutCurrent,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  };
}
