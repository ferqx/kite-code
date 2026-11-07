import {
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useConversationReadActive } from '../conversation-activity';
import { Textarea } from './components/ui/textarea';
import { useReadGate } from './ReadGate';

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

/** Plain text in, original Markdown out. Only messages render Markdown. */
export function PromptEditor(props: PromptEditorProps) {
  const blocked = useReadGate();
  const readActive = useConversationReadActive();
  const unavailable = props.disabled || blocked || !readActive;
  const root = useRef<HTMLTextAreaElement>(null);
  const current = useRef({ ...props, unavailable });
  current.current = { ...props, unavailable };
  const installed = useRef({ value: props.value, scope: props.scopeKey });
  const committedScope = useRef(props.scopeKey);
  const composition = useRef<string | undefined>(undefined);
  const pendingFocus = useRef(false);
  const source = useRef(props.value);
  const [text, setText] = useState(props.value);
  const [generation, setGeneration] = useState(0);

  if (installed.current.value !== props.value || installed.current.scope !== props.scopeKey) {
    const scopeChanged = installed.current.scope !== props.scopeKey;
    installed.current = { value: props.value, scope: props.scopeKey };
    if (source.current !== props.value) {
      source.current = props.value;
      setText(props.value);
    }
    // A composing native control must not deliver its old candidate into a new document.
    if (scopeChanged && composition.current !== undefined) {
      pendingFocus.current = root.current?.ownerDocument.activeElement === root.current;
      composition.current = undefined;
      setGeneration((value) => value + 1);
    }
  }
  const focus = useCallback((end = false) => {
    if (current.current.unavailable || !root.current) return;
    root.current.focus({ preventScroll: true });
    if (end) root.current.setSelectionRange(root.current.value.length, root.current.value.length);
  }, []);
  useImperativeHandle(
    props.inputRef,
    () => ({
      focus: () => focus(),
      moveCaretToEnd: () => focus(true),
    }),
    [focus],
  );

  useLayoutEffect(() => {
    if (committedScope.current === props.scopeKey) return;
    committedScope.current = props.scopeKey;
    const element = root.current;
    if (!element) return;
    // Native undo survives assigning an equal value. Reset it before paint when
    // the shared control changes scope, without publishing an input event.
    element.value = source.current ? '' : '\n';
    element.value = source.current;
    if (pendingFocus.current) {
      pendingFocus.current = false;
      focus(true);
    }
  }, [props.scopeKey, focus]);

  const admitted = (element: HTMLTextAreaElement) =>
    element === root.current &&
    !current.current.unavailable &&
    current.current.scopeKey === props.scopeKey;
  const publish = (element: HTMLTextAreaElement) => {
    if (element !== root.current) return;
    if (
      !admitted(element) ||
      (composition.current !== undefined && composition.current !== props.scopeKey)
    ) {
      element.value = source.current;
      return;
    }
    const next = element.value;
    if (source.current === next) return;
    source.current = next;
    setText(next);
    current.current.onChange(next);
  };
  const receiveFiles = (element: HTMLTextAreaElement, files: FileList | null) => {
    if (files?.length && admitted(element)) current.current.onFiles?.([...files]);
  };
  return (
    <div className="prompt-editor-shell">
      <Textarea
        key={generation}
        ref={root}
        className="prompt-editor"
        role="textbox"
        rows={1}
        aria-label={props.label}
        aria-multiline="true"
        aria-disabled={unavailable || undefined}
        data-disabled={props.disabled || undefined}
        placeholder={props.label}
        value={text}
        disabled={props.disabled}
        readOnly={unavailable}
        onInput={(event) => publish(event.currentTarget)}
        onCompositionStart={(event) => {
          if (admitted(event.currentTarget)) composition.current = props.scopeKey;
        }}
        onCompositionEnd={(event) => {
          if (event.currentTarget !== root.current) return;
          composition.current = undefined;
          publish(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (
            event.key !== 'Enter' ||
            event.shiftKey ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          if (!admitted(event.currentTarget)) {
            event.preventDefault();
            return;
          }
          if (
            composition.current !== undefined ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return;
          event.preventDefault();
          current.current.onSend();
        }}
        onPaste={(event) => {
          if (current.current.unavailable || event.clipboardData.files.length) {
            event.preventDefault();
            receiveFiles(event.currentTarget, event.clipboardData.files);
          }
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          receiveFiles(event.currentTarget, event.dataTransfer.files);
        }}
      />
    </div>
  );
}
