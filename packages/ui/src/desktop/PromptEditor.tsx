import { CodeNode } from '@lexical/code-core';
import { LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  $generateNodesFromMarkdownString,
  TRANSFORMERS,
} from '@lexical/markdown';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical';
import { type Ref, useImperativeHandle, useLayoutEffect, useRef } from 'react';

export interface PromptEditorHandle {
  focus(): void;
  moveCaretToEnd(): void;
}
export interface PromptEditorProps {
  value: string;
  scopeKey: string;
  label: string;
  disabled: boolean;
  inputRef?: Ref<PromptEditorHandle>;
  onChange(value: string): void;
  onSend(): void;
  onFiles?(files: readonly File[]): void;
}
const externalUpdate = 'kite-prompt-source';

function InputPlugin(props: PromptEditorProps) {
  const [editor] = useLexicalComposerContext();
  const current = useRef(props);
  const source = useRef(props.value);
  const scope = useRef(props.scopeKey);
  useLayoutEffect(() => {
    current.current = props;
    editor.setEditable(!props.disabled);
    const changedScope = scope.current !== props.scopeKey;
    if (changedScope || source.current !== props.value) {
      source.current = props.value;
      scope.current = props.scopeKey;
      editor.update(
        () => {
          $convertFromMarkdownString(props.value, TRANSFORMERS, undefined, true);
          $getRoot().selectEnd();
        },
        { tag: [externalUpdate, SKIP_DOM_SELECTION_TAG], discrete: true },
      );
      if (changedScope) editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
    }
  });
  useImperativeHandle(
    props.inputRef,
    () => ({
      focus: () => editor.focus(),
      moveCaretToEnd: () => editor.focus(() => editor.update(() => $getRoot().selectEnd())),
    }),
    [editor],
  );
  useLayoutEffect(() => {
    const enter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (
          !event ||
          event.shiftKey ||
          event.altKey ||
          event.isComposing ||
          event.keyCode === 229 ||
          editor.isComposing()
        )
          return false;
        event.preventDefault();
        current.current.onSend();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    const paste = editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (current.current.disabled) return false;
        if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
        const files = [...event.clipboardData.files];
        if (files.length && current.current.onFiles) {
          event.preventDefault();
          current.current.onFiles(files);
          return true;
        }
        const text = event.clipboardData.getData('text/plain');
        const selection = $getSelection();
        if (!text || !$isRangeSelection(selection)) return false;
        event.preventDefault();
        selection.insertNodes($generateNodesFromMarkdownString(text, TRANSFORMERS, true));
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      enter();
      paste();
    };
  }, [editor]);
  return (
    <OnChangePlugin
      ignoreSelectionChange
      onChange={(state, _editor, tags) => {
        if (tags.has(externalUpdate)) return;
        const text = state.read(() => $convertToMarkdownString(TRANSFORMERS, undefined, true));
        if (text !== source.current) {
          source.current = text;
          current.current.onChange(text);
        }
      }}
    />
  );
}

export function PromptEditor(props: PromptEditorProps) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'kite-prompt',
        editable: !props.disabled,
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode],
        editorState: () => $convertFromMarkdownString(props.value, TRANSFORMERS, undefined, true),
        onError: (error) => {
          throw error;
        },
        theme: {
          paragraph: 'prompt-paragraph',
          heading: { h1: 'prompt-heading', h2: 'prompt-heading', h3: 'prompt-heading' },
          quote: 'prompt-quote',
          code: 'prompt-code-block',
          text: {
            bold: 'prompt-bold',
            italic: 'prompt-italic',
            strikethrough: 'prompt-strike',
            code: 'prompt-inline-code',
          },
          list: { ul: 'prompt-list', ol: 'prompt-list', listitem: 'prompt-list-item' },
          link: 'prompt-file-link',
        },
      }}
    >
      <div className="prompt-editor-shell">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="prompt-editor"
              onClick={(event) => {
                if ((event.target as Element).closest('a')) event.preventDefault();
              }}
              aria-label={props.label}
              aria-placeholder="描述你想完成的工作…"
              placeholder={<span className="prompt-editor-placeholder">描述你想完成的工作…</span>}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes('Files')) event.preventDefault();
              }}
              onDropCapture={(event) => {
                if (!event.dataTransfer.files.length) return;
                event.preventDefault();
                event.stopPropagation();
                if (props.disabled) return;
                props.onFiles?.([...event.dataTransfer.files]);
              }}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <ListPlugin />
      <LinkPlugin />
      <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
      <InputPlugin {...props} />
    </LexicalComposer>
  );
}
