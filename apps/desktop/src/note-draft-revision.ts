import type { NativeDraft } from './native-bridge';

export function isCommittedPlainDraftClear(
  draft: NativeDraft,
  revision: number,
  commandId?: string,
): boolean {
  return (
    draft.revision === revision + 1 &&
    draft.consumedFrom?.revision === revision &&
    (commandId === undefined || draft.consumedFrom.commandId === commandId) &&
    draft.content === '' &&
    !draft.browserAnnotations?.length &&
    !draft.outputFiles?.length
  );
}

/** An accepted receipt does not prove that host storage consumed a draft. */
export function reconciledNoteRevision(
  revision: number,
  commandId: string,
  saved: {
    revision: number;
    consumedFrom?: { commandId: string; revision: number };
  },
): number {
  if (saved.revision === revision) return revision;
  if (
    saved.revision === revision + 1 &&
    saved.consumedFrom?.commandId === commandId &&
    saved.consumedFrom.revision === revision
  )
    return saved.revision;
  throw Error('browser_draft_save_unconfirmed');
}
