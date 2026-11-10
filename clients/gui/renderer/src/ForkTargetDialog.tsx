import { useState } from "react";
import { currentErrorText } from "./errors/currentErrorText.js";
import { Button } from "./components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog.js";
import { ForkIcon } from "./interfaceIcons.js";

export function ForkTargetDialog({
  onClose,
  onCreate,
  onCheck,
  anchor,
}: {
  anchor?: HTMLElement;
  onClose: () => void;
  onCreate: () => Promise<void>;
  onCheck: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unknown, setUnknown] = useState(false);
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      await onCreate();
    } catch (cause) {
      setUnknown(
        !!(
          cause &&
          typeof cause === "object" &&
          "submissionUnknown" in cause &&
          cause.submissionUnknown
        ),
      );
      setError(currentErrorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    try {
      await onCheck();
      onClose();
    } catch (cause) {
      setError(currentErrorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showOverlay={false}
        showCloseButton={false}
        className="fork-target-dialog"
        aria-describedby={undefined}
        finalFocus={() => (anchor?.isConnected ? anchor : false)}
      >
        <DialogTitle>从这里创建聊天分支</DialogTitle>
        {!unknown && (
          <Button
            unstyled
            data-slot={undefined}
            type="button"
            className="fork-workspace-choice"
            aria-label="创建分支"
            disabled={busy}
            onClick={() => void create()}
          >
            <ForkIcon size={18} />
            <span>{busy ? "正在创建…" : "在当前工作区中创建"}</span>
          </Button>
        )}
        {error && (
          <p className="fork-target-error" role="alert">
            {error}
            {unknown ? "。请先核对原提交，不会重新创建。" : ""}
          </p>
        )}
        {unknown && (
          <Button type="button" disabled={busy} onClick={() => void check()}>
            {busy ? "正在核对…" : "核对受理结果"}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
