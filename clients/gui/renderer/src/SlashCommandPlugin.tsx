// Catalog boundary adapted for Core. Lexical editing/IME remains in the copied input.
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode, BLUR_COMMAND, KEY_ENTER_COMMAND, KEY_TAB_COMMAND, KEY_ARROW_DOWN_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ESCAPE_COMMAND, COMMAND_PRIORITY_CRITICAL } from "lexical";
import type { AppSlashCommand } from "./slashCommandHelpers.js";
import { HISTORY_NAVIGATION_UPDATE_TAG } from "./lib/editorUpdateTags.js";
import { ComposerCatalog, filterCatalog, type ComposerCatalogData, type ComposerCatalogEntry } from "./prompt-editor/ComposerCatalog.js";
import { SlashCommandMenu } from "./SlashCommandMenu.js";

// Match only the command token immediately before a collapsed text caret.
// Selection and removal stay inside Lexical, preserving preceding draft nodes.
function $commandAtCaret() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const node = selection.anchor.getNode();
  if (!$isTextNode(node)) return null;
  const end = selection.anchor.offset;
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(node.getTextContent().slice(0, end));
  return match ? { node, start: end - match[1].length - 1, end, query: match[1].toLowerCase() } : null;
}

export function SlashCommandPlugin({ appCommands = [], container, disabled, catalog }: {
  catalog?: ComposerCatalogData;
  appCommands?: readonly AppSlashCommand[];
  container?: HTMLElement | null;
  disabled?: boolean;
  [key: string]: unknown;
}) {
  const [editor] = useLexicalComposerContext();
  const id = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const previousText = useRef("");
  useEffect(() => editor.registerUpdateListener(({ editorState, tags }) => editorState.read(() => {
    const text = $getRoot().getTextContent();
    // Selection-only updates must not reopen Escape-dismissed suggestions.
    if (text === previousText.current) {
      const token = $commandAtCaret();
      setQuery(current => current !== null && token?.query === current ? current : null);
      return;
    }
    previousText.current = text;
    const focused = editor.getRootElement() === document.activeElement;
    setQuery(focused && !tags.has(HISTORY_NAVIGATION_UPDATE_TAG) ? $commandAtCaret()?.query ?? null : null);
    setIndex(0);
  })), [editor]);
  const open = query !== null && !disabled && !!container && (catalog ? true : appCommands.length > 0);
  const rows = open && catalog ? filterCatalog(catalog.entries, query) : open ? appCommands.filter(command => [command.value, command.label, command.description, ...command.keywords ?? []]
    .some(text => text.toLowerCase().includes(query))) : [];
  const selected = Math.min(index, Math.max(0, rows.length - 1));
  const choose = (command: AppSlashCommand) => {
    editor.update(() => {
      const token = $commandAtCaret();
      if (!token || token.query !== query) return;
      token.node.select(token.start, token.end).removeText();
      command.run();
    }, { discrete: true });
    setQuery(null);
  };
  useEffect(() => editor.registerCommand(BLUR_COMMAND, () => { setQuery(null); return false; }, COMMAND_PRIORITY_CRITICAL), [editor]);
  useEffect(() => editor.registerRootListener(root => {
    if (!root) return;
    if (open) {
      root.setAttribute("aria-controls", id);
      root.setAttribute("aria-autocomplete", "list");
      if (rows.length) root.setAttribute("aria-activedescendant", `${id}-${selected}`);
      else root.removeAttribute("aria-activedescendant");
    } else {
      root.removeAttribute("aria-controls");
      root.removeAttribute("aria-autocomplete");
      root.removeAttribute("aria-activedescendant");
    }
  }), [editor, id, open, rows.length, selected]);
  useEffect(() => {
    if (!open) return;
    const activate = (event: KeyboardEvent | null) => {
      if (!catalog && (!rows.length || event?.isComposing || editor.isComposing())) return false;
      if (event?.isComposing || editor.isComposing()) return true;
      if (event?.shiftKey) return false;
      event?.preventDefault();
      if (rows[selected] && !(rows[selected] as ComposerCatalogEntry).disabled) choose(rows[selected]);
      return true;
    };
    const move = (event: KeyboardEvent, direction: number) => {
      if (!rows.length || event.isComposing || editor.isComposing()) return false;
      event.preventDefault();
      setIndex((selected + rows.length + direction) % rows.length);
      return true;
    };
    const unsubs = [
      editor.registerCommand(KEY_ENTER_COMMAND, activate, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_TAB_COMMAND, activate, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, event => move(event, 1), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, event => move(event, -1), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ESCAPE_COMMAND, event => {
        if (event.isComposing || editor.isComposing()) return false;
        event.preventDefault();
        event.stopPropagation();
        setQuery(null);
        return true;
      }, COMMAND_PRIORITY_CRITICAL),
    ];
    return () => unsubs.forEach(unsubscribe => unsubscribe());
  }, [editor, open, rows, selected]);
  useEffect(() => {
    if (!open) return;
    catalog?.refresh();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container?.contains(event.target) && !editor.getRootElement()?.contains(event.target)) setQuery(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  if (!open) return null;
  if (catalog) return createPortal(<div className="composer-catalog-position"><ComposerCatalog id={id} catalog={catalog} index={selected} query={query} anchor={container} onIndex={setIndex} onChoose={choose} /></div>, container);
  return createPortal(<SlashCommandMenu id={id} rows={rows} index={selected} query={query} anchor={container}
    onSelect={setIndex} onChoose={choose} />, container);
}
