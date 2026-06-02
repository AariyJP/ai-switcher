import { useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  describeFileSource,
  isTauriRuntime,
  openExternalUrl,
  pickAuthJsonFile,
  type FileSource,
} from "../lib/platform";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ActiveTool } from "../types";

interface AddAccountModalProps {
  isOpen: boolean;
  activeTool: ActiveTool;
  onClose: () => void;
  onImportFile: (source: FileSource, name: string) => Promise<void>;
  onAddClaudeFromCurrent: (name: string) => Promise<void>;
  onAddClaudeDesktopFromCurrent: (name: string) => Promise<void>;
  claudeDesktopImportBlocked?: boolean;
  onStartOAuth: (name: string) => Promise<{ auth_url: string }>;
  onCompleteOAuth: () => Promise<unknown>;
  onCancelOAuth: () => Promise<void>;
  onStartClaudeOAuth: (name: string) => Promise<{ auth_url: string }>;
  onCompleteClaudeOAuth: () => Promise<unknown>;
  onCancelClaudeOAuth: () => Promise<void>;
}

type CodexTab = "oauth" | "import";
type ClaudeCodeTab = "oauth" | "import_current";

export function AddAccountModal({
  isOpen,
  activeTool,
  onClose,
  onImportFile,
  onAddClaudeFromCurrent,
  onAddClaudeDesktopFromCurrent,
  claudeDesktopImportBlocked = false,
  onStartOAuth,
  onCompleteOAuth,
  onCancelOAuth,
  onStartClaudeOAuth,
  onCompleteClaudeOAuth,
  onCancelClaudeOAuth,
}: AddAccountModalProps) {
  const [codexTab, setCodexTab] = useState<CodexTab>("oauth");
  const [claudeCodeTab, setClaudeCodeTab] = useState<ClaudeCodeTab>("oauth");
  const [name, setName] = useState("");
  const [fileSource, setFileSource] = useState<FileSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [authUrl, setAuthUrl] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const tauriRuntime = isTauriRuntime();

  const isCodexOAuthMode = activeTool === "codex" && codexTab === "oauth";
  const isClaudeCodeOAuthMode =
    activeTool === "claude_code" && claudeCodeTab === "oauth";
  const isOAuthMode = isCodexOAuthMode || isClaudeCodeOAuthMode;
  const isClaudeDesktopImportBlocked =
    activeTool === "claude_desktop" && claudeDesktopImportBlocked;
  const isPrimaryDisabled =
    loading || (isOAuthMode && oauthPending) || isClaudeDesktopImportBlocked;

  const resetForm = () => {
    setName("");
    setFileSource(null);
    setError(null);
    setLoading(false);
    setOauthPending(false);
    setAuthUrl("");
  };

  const cancelActiveOAuthIfNeeded = async () => {
    if (!oauthPending) return;
    try {
      if (activeTool === "claude_code") {
        await onCancelClaudeOAuth();
      } else if (activeTool === "codex") {
        await onCancelOAuth();
      }
    } catch (err) {
      console.error("Failed to cancel login:", err);
    }
  };

  const handleClose = () => {
    void cancelActiveOAuthIfNeeded();
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
      const starter =
        activeTool === "claude_code" ? onStartClaudeOAuth : onStartOAuth;
      const completer =
        activeTool === "claude_code" ? onCompleteClaudeOAuth : onCompleteOAuth;
      const info = await starter(name.trim());
      setAuthUrl(info.auth_url);
      setOauthPending(true);
      setLoading(false);

      await completer();
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

  const handleAddClaudeCode = async () => {
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

  const handleAddClaudeDesktop = async () => {
    if (!name.trim()) {
      setError("Please enter an account name");
      return;
    }
    if (isClaudeDesktopImportBlocked) {
      setError("Close Claude Desktop before importing this account.");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await onAddClaudeDesktopFromCurrent(name.trim());
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  const renderOAuthTab = () => (
    <div className="text-muted-foreground text-sm">
      {oauthPending ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <Spinner className="text-foreground size-8" />
          <p className="text-foreground font-medium">
            Waiting for browser login...
          </p>
          <p className="text-muted-foreground text-xs">
            Please open the following link in your browser to proceed:
          </p>
          <div className="bg-muted border-border flex w-full items-center gap-2 rounded-lg border p-2">
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
              <ExternalLink data-icon="inline-start" />
              Open
            </Button>
          </div>
          {!tauriRuntime && (
            <p className="text-warning text-xs">
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
  );

  const renderNameField = () => (
    <Field>
      <FieldLabel htmlFor="account-name">Account Name</FieldLabel>
      <Input
        id="account-name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g., Work Account"
      />
    </Field>
  );

  const renderError = () =>
    error && (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );

  const primaryAction =
    activeTool === "codex"
      ? isCodexOAuthMode
        ? handleOAuthLogin
        : handleImportFile
      : activeTool === "claude_code"
        ? isClaudeCodeOAuthMode
          ? handleOAuthLogin
          : handleAddClaudeCode
        : handleAddClaudeDesktop;

  const primaryLabel = loading
    ? "Adding..."
    : activeTool === "codex"
      ? isCodexOAuthMode
        ? "Generate Login Link"
        : "Import"
      : activeTool === "claude_code"
        ? isClaudeCodeOAuthMode
          ? "Generate Login Link"
          : "Import Current Login"
        : "Import from Claude Desktop";

  const dialogTitle =
    activeTool === "codex"
      ? "Add Codex Account"
      : activeTool === "claude_code"
        ? "Add Claude Code Account"
        : "Add Claude Desktop Account";

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>

        {activeTool === "codex" ? (
          <Tabs
            value={codexTab}
            onValueChange={(value) => {
              const tab = value as CodexTab;
              if (tab === "import" && oauthPending) {
                void onCancelOAuth().catch((err) => {
                  console.error("Failed to cancel login:", err);
                });
                setOauthPending(false);
                setLoading(false);
              }
              setCodexTab(tab);
              setError(null);
            }}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="oauth">ChatGPT Login</TabsTrigger>
              <TabsTrigger value="import">Import File</TabsTrigger>
            </TabsList>

            <FieldGroup className="pt-2">
              {renderNameField()}

              <TabsContent value="oauth" className="m-0">
                {renderOAuthTab()}
              </TabsContent>

              <TabsContent value="import" className="m-0">
                <Field>
                  <FieldLabel>Select auth.json file</FieldLabel>
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
                </Field>
              </TabsContent>

              {renderError()}
            </FieldGroup>
          </Tabs>
        ) : activeTool === "claude_code" ? (
          <Tabs
            value={claudeCodeTab}
            onValueChange={(value) => {
              const next = value as ClaudeCodeTab;
              if (next !== "oauth" && oauthPending) {
                void onCancelClaudeOAuth().catch((err) => {
                  console.error("Failed to cancel Claude login:", err);
                });
                setOauthPending(false);
                setLoading(false);
              }
              setClaudeCodeTab(next);
              setError(null);
            }}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="oauth">Claude Login</TabsTrigger>
              <TabsTrigger value="import_current">Import Current</TabsTrigger>
            </TabsList>

            <FieldGroup className="pt-2">
              {renderNameField()}

              <TabsContent value="oauth" className="m-0">
                {renderOAuthTab()}
              </TabsContent>

              <TabsContent value="import_current" className="m-0">
                <p className="text-muted-foreground text-sm">
                  Import the Claude Code login currently stored on this device.
                </p>
              </TabsContent>

              {renderError()}
            </FieldGroup>
          </Tabs>
        ) : (
          <FieldGroup className="pt-2">
            {renderNameField()}
            <p className="text-muted-foreground text-sm">
              Import the Claude Desktop App login currently active on this
              device. Close Claude Desktop before importing. The app will still
              be closed automatically when you switch accounts.
            </p>
            {isClaudeDesktopImportBlocked && (
              <Alert className="border-warning/30 bg-warning/10">
                <AlertDescription className="text-warning">
                  Claude Desktop is currently running. Close it before importing
                  this account.
                </AlertDescription>
              </Alert>
            )}
            {renderError()}
          </FieldGroup>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} className="flex-1">
            Cancel
          </Button>
          <Button
            onClick={primaryAction}
            disabled={isPrimaryDisabled}
            className="flex-1"
          >
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
