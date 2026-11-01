import { Camera } from "lucide-react";
import type { Translate } from "../i18n/IntlProvider.js";
import { useEffect, useRef, useState } from "react";
import {
  isModifierPairShortcut,
  snapShotShortcutModifierPair,
  type SnapShotShortcut,
  type SnapShotModifier,
  type SnapShotServices,
} from "@areal/workbench/desktop-contract/snapshots";
import { Button } from "../components/ui/button.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { matchesShortcutBinding, setShortcutRecordingActive } from "../shortcuts/bindings.js";
import { SHORTCUT_COMMANDS } from "../shortcuts/shortcutCommands.js";

export function shortcutLabel(shortcut: SnapShotShortcut) {
  if (isModifierPairShortcut(shortcut)) {
    const label = { shift: "Shift", meta: "⌘", control: "Ctrl", alt: "⌥" }[
      snapShotShortcutModifierPair(shortcut)
    ];
    return `${label} + ${label}`;
  }
  return [
    shortcut.modKey && "Mod",
    shortcut.ctrlKey && "Ctrl",
    shortcut.altKey && "⌥",
    shortcut.shiftKey && "Shift",
    shortcut.metaKey && "⌘",
    shortcut.key.toUpperCase(),
  ]
    .filter(Boolean)
    .join(" + ");
}
export function snapShotShortcutConflict(shortcut: SnapShotShortcut) {
  if (isModifierPairShortcut(shortcut)) return null;
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const event = {
    ...shortcut,
    metaKey: shortcut.metaKey || (shortcut.modKey && apple),
    ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !apple),
  };
  return (
    SHORTCUT_COMMANDS.find((command) =>
      command.defaultBindings.some((binding) => matchesShortcutBinding(event, binding)),
    )?.id ?? null
  );
}
const modifiers: Record<string, SnapShotModifier> = {
  Shift: "shift",
  Meta: "meta",
  OS: "meta",
  Control: "control",
  Alt: "alt",
  AltGraph: "alt",
};
const codes: Record<SnapShotModifier, readonly [string, string]> = {
  shift: ["ShiftLeft", "ShiftRight"],
  meta: ["MetaLeft", "MetaRight"],
  control: ["ControlLeft", "ControlRight"],
  alt: ["AltLeft", "AltRight"],
};
// Adapted from T3 Code's useSnapShotShortcutRecorder, MIT, Copyright 2026 T3 Tools Inc.
export function SnapShotShortcutRecorder({
  bridge,
  value,
  disabled,
  onRecord,
  onError,
}: {
  bridge: SnapShotServices;
  value: SnapShotShortcut;
  disabled?: boolean;
  onRecord: (value: SnapShotShortcut) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [recording, setRecording] = useState(false);
  const held = useRef(new Set<string>());
  const request = useRef(0);
  const stop = () => {
    request.current++;
    held.current.clear();
    setRecording(false);
    setShortcutRecordingActive(false);
    void bridge.setSnapShotShortcutSuppressed(false).catch(() => {});
  };
  useEffect(() => {
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("blur", stop);
      stop();
    };
  }, [bridge]);
  return (
    <Button
      type="button"
      variant="outline"
      data-testid="snapshot-shortcut-recorder"
      aria-label={t("snapshots.recordShortcut")}
      aria-pressed={recording}
      disabled={disabled}
      onBlur={stop}
      onClick={async () => {
        if (recording) return stop();
        const id = ++request.current;
        setShortcutRecordingActive(true);
        try {
          await bridge.setSnapShotShortcutSuppressed(true);
          if (id === request.current) setRecording(true);
          else await bridge.setSnapShotShortcutSuppressed(false);
        } catch (cause) {
          stop();
          onError((cause as Error).message);
        }
      }}
      onKeyUp={(event) => held.current.delete(event.code)}
      onKeyDown={(event) => {
        if (!recording || event.key === "Tab" || event.repeat || event.nativeEvent.isComposing)
          return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") return stop();
        const modifier = modifiers[event.key];
        if (modifier) {
          held.current.add(event.code);
          if (codes[modifier].every((code) => held.current.has(code))) {
            stop();
            onRecord(
              modifier === "shift"
                ? { kind: "both-shift-keys" }
                : { kind: "modifier-pair", modifier },
            );
          }
          return;
        }
        if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return;
        const key = /^Key[A-Z]$/.test(event.code)
          ? event.code.slice(3).toLowerCase()
          : /^Digit[0-9]$/.test(event.code)
            ? event.code.slice(5)
            : event.key.toLowerCase();
        stop();
        onRecord({
          key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          modKey: false,
        });
      }}
    >
      {recording ? t("snapshots.pressShortcut") : shortcutLabel(value)}
    </Button>
  );
}

export function snapShotCommandEntries(
  bridge: SnapShotServices | undefined,
  t: Translate,
  onError: (message: string) => void,
) {
  if (!bridge) return [];
  return [
    {
      value: "snapshot",
      label: t("snapshots.capture"),
      description: t("snapshots.shortcutDescription"),
      icon: <Camera size={16} />,
      group: "功能" as const,
      run: () => {
        void bridge.captureSnapShot().catch((cause: Error) => onError(cause.message));
      },
    },
  ];
}
