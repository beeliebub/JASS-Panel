import { useEffect, useMemo, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { indentWithTab, defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { StreamLanguage } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet, type ViewUpdate } from "@codemirror/view";

const MASKED_PLACEHOLDER = "<panel-masked>";
const maskedSecretMark = Decoration.mark({
  class: "cm-masked-placeholder",
  attributes: { title: "Secret is masked. Replace this placeholder by typing, or leave it unchanged to preserve the value." },
});
const maskedSecretPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = findMaskedPlaceholders(view.state);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.decorations = findMaskedPlaceholders(update.state);
  }
}, { decorations: (instance) => instance.decorations });

export function CodeEditor({ ariaLabel, filename, value, onChange, readOnly }: {
  readonly ariaLabel: string;
  readonly filename: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly readOnly: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const suppressChange = useRef(false);
  const onChangeRef = useRef(onChange);
  const initialValue = useRef(value);
  onChangeRef.current = onChange;
  initialValue.current = value;
  const extensions = useMemo<Extension[]>(() => {
    const extension: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      maskedSecretPlugin,
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({ "aria-label": ariaLabel, "aria-multiline": "true", spellcheck: "false" }),
      EditorView.cspNonce.of(panelCspNonce()),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !suppressChange.current) onChangeRef.current(update.state.doc.toString());
      }),
    ];
    const lower = filename.toLocaleLowerCase("en-US");
    if (lower.endsWith(".json")) extension.push(json());
    else if (lower.endsWith(".yml") || lower.endsWith(".yaml")) extension.push(yaml());
    else if (lower.endsWith(".properties")) extension.push(StreamLanguage.define(properties));
    return extension;
  }, [ariaLabel, filename, readOnly]);

  useEffect(() => {
    const parent = container.current;
    if (parent === null) return undefined;
    const editor = new EditorView({ state: EditorState.create({ doc: initialValue.current, extensions }), parent });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const editor = view.current;
    if (editor === null || editor.state.doc.toString() === value) return;
    suppressChange.current = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    suppressChange.current = false;
  }, [value]);

  return <div aria-label={ariaLabel} className="file-code-editor min-h-[420px] overflow-auto rounded-lg border border-panel-line bg-panel-page" ref={container} />;
}

function findMaskedPlaceholders(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const ranges = [];
  for (let from = text.indexOf(MASKED_PLACEHOLDER); from >= 0; from = text.indexOf(MASKED_PLACEHOLDER, from + MASKED_PLACEHOLDER.length)) {
    ranges.push(maskedSecretMark.range(from, from + MASKED_PLACEHOLDER.length));
  }
  return Decoration.set(ranges, true);
}

function panelCspNonce(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="panel-csp-nonce"]')?.content ?? "";
}
