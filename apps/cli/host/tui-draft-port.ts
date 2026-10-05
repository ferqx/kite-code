import type { TuiDraftPort, TuiDraftScope } from '@kite-ai/ui/tui';
import { type openTuiDraftFile, TuiDraftError, type TuiStoredDraft } from './tui-drafts';

/** Debounce full-document I/O; scope switches/EOF/host exit explicitly flush the latest editor text. */
export function createTuiDraftPort(input: {
  file: ReturnType<typeof openTuiDraftFile>;
  notify: (code: string) => void;
  association: (row: TuiStoredDraft) => Promise<'current' | 'unavailable'>;
  delayMs?: number;
}) {
  type Editor = {
    scope: TuiDraftScope;
    stored?: TuiStoredDraft;
    text: string;
    version: number;
    dirty: boolean;
    timer?: ReturnType<typeof setTimeout>;
  };
  const editors = new Map<string, Editor>();
  let closed = false;
  const key = (scope: TuiDraftScope) =>
    JSON.stringify([scope.storeId, scope.workspaceId, scope.sessionId]);
  const error = (caught: unknown) =>
    input.notify(caught instanceof TuiDraftError ? caught.code : 'tui_draft_storage_unavailable');
  const state = (scope: TuiDraftScope) => {
    if (closed) throw new TuiDraftError('tui_draft_storage_unavailable');
    let editor = editors.get(key(scope));
    if (!editor) {
      let stored: TuiStoredDraft | undefined;
      try {
        stored = input.file.load(scope);
      } catch (caught) {
        error(caught);
      }
      editor = { scope: { ...scope }, stored, text: stored?.text ?? '', version: 0, dirty: false };
      editors.set(key(scope), editor);
    }
    return editor;
  };
  const save = (editor: Editor) => {
    if (editor.timer) {
      clearTimeout(editor.timer);
      editor.timer = undefined;
    }
    if (!editor.dirty) return true;
    if (!editor.stored) {
      input.notify('tui_draft_storage_unavailable');
      return false;
    }
    try {
      editor.stored = input.file.save(editor.scope, editor.stored.revision, editor.text);
      editor.dirty = false;
      return true;
    } catch (caught) {
      error(caught);
      return false;
    }
  };
  const flush = () => {
    let success = true;
    for (const editor of editors.values()) if (!save(editor)) success = false;
    return success;
  };
  const port: TuiDraftPort = {
    flush,
    read(scope) {
      return state(scope).text;
    },
    edit(scope, text) {
      const editor = state(scope);
      if (editor.text === text) return;
      editor.text = text;
      editor.version++;
      editor.dirty = true;
      if (editor.timer) clearTimeout(editor.timer);
      editor.timer = setTimeout(() => save(editor), input.delayMs ?? 180);
    },
    version(scope) {
      return state(scope).version;
    },
    accepted(scope, observedVersion) {
      const editor = state(scope);
      if (editor.version !== observedVersion) return false;
      const original = editor.text;
      editor.text = '';
      editor.dirty = true;
      if (!save(editor)) {
        editor.text = original;
        editor.dirty = true;
        return false;
      }
      editor.version++;
      return true;
    },
    list() {
      return input.file.list().map(({ text: _text, ...summary }) => summary);
    },
    async original(id) {
      const row = input.file.readId(id);
      return { ...row, association: await input.association(row) };
    },
  };
  return {
    port,
    flush,
    close() {
      if (!flush()) return false;
      closed = true;
      input.file.close();
      return true;
    },
  };
}
