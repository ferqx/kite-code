/** Private user text only. The host owns paths, profile lease and durable revisions. */
export type TuiDraftScope = Readonly<{ storeId: string; workspaceId: string; sessionId: string }>;
export type TuiOriginalDraft = TuiDraftScope &
  Readonly<{ id: string; revision: string; text: string }>;
export interface TuiDraftPort {
  flush(): boolean;
  read(scope: TuiDraftScope): string;
  edit(scope: TuiDraftScope, text: string): void;
  version(scope: TuiDraftScope): number;
  accepted(scope: TuiDraftScope, observedVersion: number): boolean;
  list(): readonly Omit<TuiOriginalDraft, 'text'>[];
  original(id: string): Promise<TuiOriginalDraft & { association: 'current' | 'unavailable' }>;
}
