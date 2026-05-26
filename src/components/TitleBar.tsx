import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isTauriRuntime } from "../lib/platform";
import { cn } from "@/lib/utils";

const appWindow = getCurrentWindow();
const isMacOs =
  typeof navigator !== "undefined" &&
  /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent);

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  const handleDrag = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!isTauriRuntime() || event.button !== 0) return;
    void appWindow.startDragging();
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (!isTauriRuntime()) return;
    void appWindow.toggleMaximize();
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() || isMacOs) return;
    let unlisten: (() => void) | undefined;

    const sync = async () => {
      try {
        setIsMaximized(await appWindow.isMaximized());
      } catch (err) {
        console.error("Failed to read window state:", err);
      }
    };
    void sync();

    appWindow
      .onResized(() => {
        void sync();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error("Failed to watch window resize:", err);
      });

    return () => {
      unlisten?.();
    };
  }, []);

  return (
    <div
      onMouseDown={handleDrag}
      onDoubleClick={handleDoubleClick}
      className="bg-background flex h-14 items-center px-3 select-none"
    >
      <div className={cn("h-full flex-1", isMacOs ? "ml-22 mr-2" : "mr-3")} />
      {!isMacOs && (
        <div className="flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              void appWindow.minimize();
            }}
            className="size-8"
            title="Minimize"
          >
            <Minus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              void appWindow.toggleMaximize();
            }}
            className="size-8"
            title={isMaximized ? "Restore" : "Maximize"}
          >
            <Square className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              void appWindow.close();
            }}
            className="hover:bg-destructive hover:text-destructive-foreground size-8"
            title="Close"
          >
            <X className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
