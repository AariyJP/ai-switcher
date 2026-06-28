import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { isTauriRuntime } from "@/lib/platform";
import { cn } from "@/lib/utils";

const segoeGlyphStyle: React.CSSProperties = {
  fontFamily: '"Segoe Fluent Icons", "Segoe MDL2 Assets"',
  fontSize: "10px",
  lineHeight: 1,
};

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
      className="bg-background flex h-14 items-stretch select-none pl-3"
    >
      <div className={cn("flex-1", isMacOs && "ml-22 mr-2")} />
      {!isMacOs && (
        <div className="flex" onMouseDown={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              void appWindow.minimize();
            }}
            className="h-full w-[46px] rounded-none border-0"
            title="Minimize"
          >
            <span style={segoeGlyphStyle} aria-hidden>{"\u{E921}"}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              void appWindow.toggleMaximize();
            }}
            className="h-full w-[46px] rounded-none border-0"
            title={isMaximized ? "Restore" : "Maximize"}
          >
            <span style={segoeGlyphStyle} aria-hidden>
              {isMaximized ? "\u{E923}" : "\u{E922}"}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              void appWindow.close();
            }}
            className="h-full w-[46px] rounded-none border-0"
            title="Close"
          >
            <span style={segoeGlyphStyle} aria-hidden>{"\u{E8BB}"}</span>
          </Button>
        </div>
      )}
    </div>
  );
}
