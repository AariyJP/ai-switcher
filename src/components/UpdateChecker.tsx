import { useState, useEffect, useCallback } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { isTauriRuntime } from "../lib/platform";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; downloaded: number; total: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export function UpdateChecker() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);

  const checkForUpdate = useCallback(async () => {
    if (!isTauriRuntime()) return;

    try {
      setStatus({ kind: "checking" });
      setDismissed(false);
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setStatus({ kind: "available", update });
      } else {
        setStatus({ kind: "idle" });
      }
    } catch (err) {
      console.error("Update check failed:", err);
      setStatus({ kind: "idle" });
    }
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void checkForUpdate();
  }, [checkForUpdate]);

  const handleDownloadAndInstall = async () => {
    if (status.kind !== "available") return;
    const { update } = status;

    try {
      if (!isTauriRuntime()) return;
      let downloaded = 0;
      let total: number | null = null;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            setStatus({ kind: "downloading", downloaded: 0, total });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setStatus({ kind: "downloading", downloaded, total });
            break;
          case "Finished":
            setStatus({ kind: "ready" });
            break;
        }
      });

      setStatus({ kind: "ready" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Update install failed:", err);
      setStatus({ kind: "error", message });
    }
  };

  const handleRelaunch = async () => {
    try {
      if (!isTauriRuntime()) return;
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      console.error("Relaunch failed:", err);
    }
  };

  if (!isTauriRuntime()) return null;
  if (status.kind === "idle" || status.kind === "checking" || dismissed) return null;

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="fixed bottom-6 left-1/2 z-50 w-full max-w-md -translate-x-1/2 px-4">
      <Card className="p-4 shadow-xl">
        {status.kind === "available" && (
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-foreground text-sm font-medium">
                Update available: v{status.update.version}
              </p>
              {status.update.body && (
                <p className="text-muted-foreground mt-0.5 truncate text-xs">
                  {status.update.body}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setDismissed(true)}>
                Later
              </Button>
              <Button size="sm" onClick={handleDownloadAndInstall}>
                Update
              </Button>
            </div>
          </div>
        )}

        {status.kind === "downloading" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-foreground text-sm font-medium">Downloading update...</p>
              <p className="text-muted-foreground text-xs">
                {formatBytes(status.downloaded)}
                {status.total ? ` / ${formatBytes(status.total)}` : ""}
              </p>
            </div>
            <Progress
              value={
                status.total && status.total > 0
                  ? Math.min(100, (status.downloaded / status.total) * 100)
                  : 50
              }
              className="h-1.5"
            />
          </div>
        )}

        {status.kind === "ready" && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-foreground text-sm font-medium">
              Update ready. Restart to apply.
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setDismissed(true)}>
                Later
              </Button>
              <Button size="sm" onClick={handleRelaunch}>
                Restart
              </Button>
            </div>
          </div>
        )}

        {status.kind === "error" && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-destructive text-sm">Update failed: {status.message}</p>
            <Button variant="outline" size="sm" onClick={() => setDismissed(true)}>
              Dismiss
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
