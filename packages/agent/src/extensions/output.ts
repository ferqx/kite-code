import type { ExecutionOutputPage } from '../storage/types';
import type { OperationRef, Operations } from './index';

export type { ExecutionOutputPage } from '../storage/types';
export interface OperationOutputOptions {
  afterSeq?: string;
  upperSeq?: string;
  limit?: number;
}
/** Scoped persisted output only. Cursor cancellation is local to the read, never a stop request. */
export interface OutputOperations extends Operations {
  readOutput(ref: OperationRef, options?: OperationOutputOptions): Promise<ExecutionOutputPage>;
}
