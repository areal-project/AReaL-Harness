import { useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyField, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";

// Decorations project Markdown without rewriting it. The document owner
// receives edits and owns revision-checked saves; this view never writes files.
const externalText = Annotation.define<boolean>();
function decorate(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const hide = (from: number, to: number) => {
    if (from < to) ranges.push(Decoration.replace({}).range(from, to));
  };
  syntaxTree(state).iterate({
    enter(node) {
      const heading = /^ATXHeading([1-6])$/.exec(node.name);
      if (heading) {
        const marks = node.node.getChildren("HeaderMark");
        let from = marks[0].to;
        let to = marks.length > 1 ? marks.at(-1)!.from : node.to;
        while (from < to && /\s/.test(state.sliceDoc(from, from + 1))) from++;
        while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--;
        hide(node.from, from);
        hide(to, node.to);
        if (from < to) ranges.push(Decoration.mark({
          class: `workspace-markdown-heading workspace-markdown-heading-${heading[1]}`,
          attributes: { role: "heading", "aria-level": heading[1] },
        }).range(from, to));
      } else if (node.name === "ListMark") {
        ranges.push(Decoration.line({ class: "workspace-markdown-list-item" }).range(state.doc.lineAt(node.from).from));
        ranges.push(Decoration.mark({ class: "workspace-markdown-list-marker" }).range(node.from, node.to));
      } else if (node.name === "StrongEmphasis" || node.name === "Emphasis" || node.name === "InlineCode") {
        const marks = node.node.getChildren(node.name === "InlineCode" ? "CodeMark" : "EmphasisMark");
        if (marks.length < 2) return;
        const from = marks[0].to, to = marks.at(-1)!.from;
        hide(node.from, from);
        hide(to, node.to);
        if (from < to) ranges.push(Decoration.mark({
          tagName: node.name === "StrongEmphasis" ? "strong" : node.name === "Emphasis" ? "em" : "code",
          class: "workspace-markdown-inline",
        }).range(from, to));
      } else if (node.name === "Link") {
        const marks = node.node.getChildren("LinkMark");
        const url = node.node.getChild("URL");
        if (!url || marks.length < 2) return;
        const href = state.sliceDoc(url.from, url.to);
        // Preserve the former reader's supported external-link boundary.
        if (!/^https?:\/\//i.test(href)) return;
        const from = marks[0].to, to = marks[1].from;
        hide(node.from, from);
        hide(to, node.to);
        if (from < to) ranges.push(Decoration.mark({
          class: "workspace-markdown-link",
          attributes: { role: "link", tabindex: "0", "data-markdown-link": href, title: href },
        }).range(from, to));
      }
    },
  });
  return Decoration.set(ranges, true);
}

const readingDecorations = StateField.define<DecorationSet>({
  create: decorate,
  update: (value, transaction) => transaction.docChanged || syntaxTree(transaction.state) !== syntaxTree(transaction.startState)
    ? decorate(transaction.state) : value,
  provide: field => EditorView.decorations.from(field),
});

export function WorkspaceMarkdownView({ text, state, disabled, onChange, onBlur, onLink }: {
  text: string;
  state?: EditorState;
  disabled: boolean;
  onChange: (text: string, state: EditorState) => void;
  onBlur: () => void;
  onLink: (url: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onBlur, onLink });
  callbacks.current = { onChange, onBlur, onLink };
  const access = useRef(new Compartment());
  const accessMode = (disabled: boolean) => [
    EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled),
    EditorView.contentAttributes.of({ "aria-label": "文件正文", "aria-readonly": String(disabled), tabindex: "0" }),
  ];
  useLayoutEffect(() => {
    const followLink = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-markdown-link]") : null;
      if (!target) return false;
      event.preventDefault();
      callbacks.current.onLink(target.dataset.markdownLink!);
      return true;
    };
    const previous = state?.doc.toString() === text.replace(/\r\n?/g, "\n") ? state : undefined;
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        selection: previous?.selection,
        extensions: [
          markdown(), readingDecorations, EditorView.lineWrapping,
          EditorState.lineSeparator.of(text.includes("\r\n") ? "\r\n" : "\n"),
          history(), keymap.of([...defaultKeymap, ...historyKeymap]),
          ...(previous ? [historyField.init(() => previous.field(historyField))] : []),
          access.current.of(accessMode(disabled)),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalText))) {
              callbacks.current.onChange(update.state.sliceDoc(), update.state);
            }
          }),
          EditorView.domEventHandlers({
            click: followLink,
            keydown: event => event.key === "Enter" ? followLink(event) : false,
            blur: () => { callbacks.current.onBlur(); return false; },
          }),
        ],
      }),
    });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, []);
  useLayoutEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== text.replace(/\r\n?/g, "\n")) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: externalText.of(true) });
    }
  }, [text]);
  useLayoutEffect(() => {
    editor.current?.dispatch({ effects: access.current.reconfigure(accessMode(disabled)) });
  }, [disabled]);
  return <div ref={host} className="workspace-file-markdown" />;
}
