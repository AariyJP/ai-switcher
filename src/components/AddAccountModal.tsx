import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import {
  describeFileSource,
  isTauriRuntime,
  openExternalUrl,
  pickAuthJsonFile,
  type FileSource,
} from "../lib/platform";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ToolKind } from "../types";

interface AddAccountModalProps {
  isOpen: boolean;
  tool: ToolKind;
  onClose: () => void;
  onImportFile: (source: FileSource, name: string) => Promise<void>;
  onAddClaudeFromCurrent: (name: string) => Promise<void>;
  onStartOAuth: (name: string) => Promise<{ auth_url: string }>;
  onCompleteOAuth: () => Promise<unknown>;
  onCancelOAuth: () => Promise<void>;
}

type Tab = "oauth" | "import";

export function AddAccountModal({
  isOpen,
  tool,
  onClose,
  onImportFile,
  onAddClaudeFromCurrent,
  onStartOAuth,
  onCompleteOAuth,
  onCancelOAuth,
}: AddAccountModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("oauth");
  const [name, setName] = useState("");
  const [fileSource, setFileSource] = useState<FileSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [authUrl, setAuthUrl] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const isPrimaryDisabled = loading || (tool === "codex" && activeTab === "oauth" && oauthPending);
  const tauriRuntime = isTauriRuntime();

  const resetForm = () => {
    setName("");
    setFileSource(null);
    setError(null);
    setLoading(false);
    setOauthPending(false);
    setAuthUrl("");
  };

  const handleClose = () => {
    if (oauthPending) {
      onCancelOAuth();
    }
    resetForm();
    onClose();
  };

  const handleOAuthLogin = async () => {
    if (!name.trim()) {
      setError("Please enter an account name");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const info = await onStartOAuth(name.trim());
      setAuthUrl(info.auth_url);
      setOauthPending(true);
      setLoading(false);

      await onCompleteOAuth();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      setOauthPending(false);
    }
  };

  const handleSelectFile = async () => {
    try {
      const selected = await pickAuthJsonFile();
      if (selected) setFileSource(selected);
    } catch (err) {
      console.error("Failed to open file dialog:", err);
    }
  };

  const handleImportFile = async () => {
    if (!name.trim()) {
      setError("Please enter an account name");
      return;
    }
    if (!fileSource) {
      setError("Please select an auth.json file");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await onImportFile(fileSource, name.trim());
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  const handleAddClaude = async () => {
    if (!name.trim()) {
      setError("Please enter an account name");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await onAddClaudeFromCurrent(name.trim());
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add {tool === "claude" ? "Claude" : "Codex"} Account</DialogTitle>
        </DialogHeader>

        {tool === "claude" ? (
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Account Name</label>
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Work Account"
              />
            </div>
            <p className="text-muted-foreground text-sm">
              Import the Claude Code login currently stored on this Mac.
            </p>
            {error && (
              <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border p-3 text-sm">
                {error}
              </div>
            )}
          </div>
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={(value) => {
              const tab = value as Tab;
              if (tab === "import" && oauthPending) {
                void onCancelOAuth().catch((err) => {
                  console.error("Failed to cancel login:", err);
                });
                setOauthPending(false);
                setLoading(false);
              }
              setActiveTab(tab);
              setError(null);
            }}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="oauth">ChatGPT Login</TabsTrigger>
              <TabsTrigger value="import">Import File</TabsTrigger>
            </TabsList>

            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">Account Name</label>
                <Input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Work Account"
                />
              </div>

            <TabsContent value="oauth" className="m-0">
              <div className="text-muted-foreground text-sm">
                {oauthPending ? (
                  <div className="py-2 text-center">
                    <Loader2 className="text-foreground mx-auto mb-3 size-8 animate-spin" />
                    <p className="text-foreground mb-2 font-medium">
                      Waiting for browser login...
                    </p>
                    <p className="text-muted-foreground mb-4 text-xs">
                      Please open the following link in your browser to proceed:
                    </p>
                    <div className="bg-muted border-border mb-2 flex items-center gap-2 rounded-lg border p-2">
                      <Input
                        type="text"
                        readOnly
                        value={authUrl}
                        className="border-none bg-transparent text-xs shadow-none focus-visible:ring-0"
                      />
                      <Button
                        size="sm"
                        variant={copied ? "secondary" : "outline"}
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(authUrl)
                            .then(() => {
                              setCopied(true);
                              setTimeout(() => setCopied(false), 2000);
                            })
                            .catch(() => {
                              setError("Clipboard unavailable. Copy the link manually.");
                            });
                        }}
                      >
                        {copied ? "Copied!" : "Copy"}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          void openExternalUrl(authUrl);
                        }}
                      >
                        <ExternalLink className="size-3" />
                        Open
                      </Button>
                    </div>
                    {!tauriRuntime && (
                      <p className="text-xs text-amber-600">
                        OAuth login must finish on the same host machine because the
                        callback redirects to `localhost`.
                      </p>
                    )}
                  </div>
                ) : (
                  <p>
                    Click the button below to generate a login link. You will need to open it
                    in your browser to authenticate.
                  </p>
                )}
              </div>
            </TabsContent>

            <TabsContent value="import" className="m-0">
              <div className="space-y-2">
                <label className="text-sm font-medium">Select auth.json file</label>
                <div className="flex gap-2">
                  <div className="bg-muted border-input text-muted-foreground flex-1 truncate rounded-md border px-3 py-2 text-sm">
                    {describeFileSource(fileSource)}
                  </div>
                  <Button variant="outline" onClick={handleSelectFile}>
                    Browse...
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Import credentials from an existing Codex auth.json file
                </p>
              </div>
            </TabsContent>

            {error && (
              <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border p-3 text-sm">
                {error}
              </div>
            )}
          </div>
          </Tabs>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} className="flex-1">
            Cancel
          </Button>
          <Button
            onClick={
              tool === "claude"
                ? handleAddClaude
                : activeTab === "oauth"
                  ? handleOAuthLogin
                  : handleImportFile
            }
            disabled={isPrimaryDisabled}
            className="flex-1"
          >
            {loading
              ? "Adding..."
              : tool === "claude"
                ? "Import Current Login"
                : activeTab === "oauth"
                  ? "Generate Login Link"
                  : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
