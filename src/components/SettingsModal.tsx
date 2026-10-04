import type { DesktopReopenPreference } from "@/lib/desktopReopen";
import type { CodexClosePreference } from "@/lib/codexClosePreference";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SettingsModalProps {
  open: boolean;
  reopenPreference: DesktopReopenPreference;
  onReopenPreferenceChange: (value: DesktopReopenPreference) => void;
  closePreference: CodexClosePreference;
  onClosePreferenceChange: (value: CodexClosePreference) => void;
  onClose: () => void;
}

export function SettingsModal({
  open,
  reopenPreference,
  onReopenPreferenceChange,
  closePreference,
  onClosePreferenceChange,
  onClose,
}: SettingsModalProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="codex-close-preference">Codex close method</FieldLabel>
            <Select
              value={closePreference}
              onValueChange={(value) => onClosePreferenceChange(value as CodexClosePreference)}
            >
              <SelectTrigger id="codex-close-preference" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">Ask every time</SelectItem>
                <SelectItem value="graceful">Gracefully close</SelectItem>
                <SelectItem value="force">Force close</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              Graceful close lets Codex finish cleanup. Force close stops it immediately and may lose unsaved work.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="desktop-reopen-preference">Reopen Codex after close</FieldLabel>
            <Select
              value={reopenPreference}
              onValueChange={(value) => onReopenPreferenceChange(value as DesktopReopenPreference)}
            >
              <SelectTrigger id="desktop-reopen-preference" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">Ask every time</SelectItem>
                <SelectItem value="always">Reopen desktop app</SelectItem>
                <SelectItem value="never">Keep closed</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              Applies to detected Codex desktop apps on macOS and Windows. When switching accounts, the app reopens after the switch succeeds.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
