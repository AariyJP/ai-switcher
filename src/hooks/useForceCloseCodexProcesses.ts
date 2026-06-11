import { useCallback, useState } from "react";
import type { ProcessInfo } from "../types";
import { invokeBackend } from "../lib/platform";
import { pluralize } from "../lib/pluralize";

interface KillCodexProcessesResult {
  targeted_count: number;
}

interface UseForceCloseCodexProcessesOptions {
  checkProcesses: () => Promise<ProcessInfo | null>;
  showToast: (message: string, isError?: boolean) => void;
  formatError: (err: unknown) => string;
}

export function useForceCloseCodexProcesses({
  checkProcesses,
  showToast,
  formatError,
}: UseForceCloseCodexProcessesOptions) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isForceClosing, setIsForceClosing] = useState(false);

  const forceCloseCodexProcesses = useCallback(async () => {
    try {
      setIsForceClosing(true);

      const result = await invokeBackend<KillCodexProcessesResult>(
        "kill_codex_processes"
      );
      const latestProcessInfo = await checkProcesses();
      const targetedCount = result.targeted_count;
      const remainingCount = latestProcessInfo?.count ?? 0;
      const closedCount = Math.max(0, targetedCount - remainingCount);

      if (targetedCount === 0) {
        showToast("No running Codex processes found.");
      } else if (remainingCount === 0) {
        showToast(
          `Force closed ${targetedCount} Codex ${pluralize(targetedCount, "session")}.`
        );
      } else if (closedCount > 0) {
        showToast(
          `Force closed ${closedCount}/${targetedCount} Codex ${pluralize(targetedCount, "session")}. ${remainingCount} ${pluralize(remainingCount, "is", "are")} still running.`,
          true
        );
      } else {
        showToast(
          `Could not force close ${remainingCount} Codex ${pluralize(remainingCount, "session")}.`,
          true
        );
      }

      return latestProcessInfo;
    } catch (err) {
      console.error("Failed to force close Codex processes:", err);
      showToast(`Force close failed: ${formatError(err)}`, true);
      return null;
    } finally {
      setConfirmOpen(false);
      setIsForceClosing(false);
    }
  }, [checkProcesses, formatError, showToast]);

  return {
    forceCloseConfirmOpen: confirmOpen,
    setForceCloseConfirmOpen: setConfirmOpen,
    isForceClosingCodex: isForceClosing,
    forceCloseCodexProcesses,
  };
}
