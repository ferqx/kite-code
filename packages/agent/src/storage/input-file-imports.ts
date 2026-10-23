import type { ArtifactReference } from './types';

/** Registered immutable bytes. A prepared import is not yet a message attachment. */
export interface InputFileImport {
  id: string;
  sessionId: string;
  subjectId: string;
  originStoreId: string;
  name: string;
  /** Current host locator derived only after Store/session/subject registration checks. */
  uri: string;
  reference: ArtifactReference;
  state: 'prepared' | 'bound' | 'released';
  boundCommandId: string | null;
  createdAt: number;
}

export interface InputFileImportScope {
  expectedStoreId: string;
  sessionId: string;
  subjectId: string;
  id: string;
}
