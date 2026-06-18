// ── 外部编辑器 ($EDITOR) hook ──

import type { Dispatch } from 'react';
import React from 'react';
import { editorInputPath } from '@/core/config/index';
import type { EditorContentHandle } from '../components/InputLine';
import type { Action } from '../reducers/actions';

export function useExternalEditor(
  state: { editorRequested: boolean },
  _workspace: string,
  dispatch: Dispatch<Action>,
  editorContentRef: React.MutableRefObject<EditorContentHandle | null>,
) {
  React.useEffect(() => {
    if (!state.editorRequested) return;
    if (!process.env.EDITOR) {
      dispatch({ type: 'EDITOR_DONE' });
      return;
    }

    let cancelled = false;
    const tmpFile = editorInputPath(Date.now().toString(36));

    import('node:fs')
      .then(({ writeFileSync }) => {
        const content = editorContentRef.current?.getContent() ?? '';
        writeFileSync(tmpFile, content, 'utf-8');
      })
      .then(() => import('node:child_process'))
      .then(({ spawn }) => {
        const proc = spawn(process.env.EDITOR!, [tmpFile], { stdio: 'inherit', shell: true });
        proc.on('exit', () => {
          if (cancelled) return;
          import('node:fs').then(({ readFileSync, unlinkSync }) => {
            try {
              const content = readFileSync(tmpFile, 'utf-8').trim();
              unlinkSync(tmpFile);
              if (content) {
                editorContentRef.current?.handleEditorResult(content);
              }
            } catch {
              /* file may not exist */
            }
            dispatch({ type: 'EDITOR_DONE' });
          });
        });
        proc.on('error', () => {
          if (!cancelled) dispatch({ type: 'EDITOR_DONE' });
        });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'EDITOR_DONE' });
      });

    return () => {
      cancelled = true;
      import('node:fs')
        .then(({ unlinkSync }) => {
          try {
            unlinkSync(tmpFile);
          } catch {}
        })
        .catch(() => {});
    };
  }, [
    state.editorRequested,
    dispatch,
    editorContentRef.current?.handleEditorResult,
    editorContentRef.current?.getContent,
  ]);
}
