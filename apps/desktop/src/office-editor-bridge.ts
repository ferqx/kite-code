/** Read-only legacy snapshots remain available for persisted exact draft references. */
export type OfficeEditorSnapshot = {
  editorId: string;
  revision: number;
  name: string;
  slideCount: number;
  notes: string[];
  sourceHash: string;
};
