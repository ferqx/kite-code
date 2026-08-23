import type { RuntimeCommand, RuntimeCommandReceipt } from './commands';
import type { RuntimeNotification, RuntimeSubscription } from './notifications';
import type { RuntimeQuery, RuntimeQueryResult } from './queries';

export const RUNTIME_CONTRACT_SCHEMA_ = 'kite.runtime-contract.v1' as const;

export * from './capabilities';
export * from './commands';
export * from './notifications';
export * from './observability';
export * from './presentation';
export * from './projections';
export * from './queries';

export interface RuntimeContractBoundary {
  readonly audience: 'kite-app';
  readonly transport: 'in-process';
  readonly revision: 'runtime-contract-current';
  readonly schema: typeof RUNTIME_CONTRACT_SCHEMA_;
}

export const RUNTIME_CONTRACT_BOUNDARY_: RuntimeContractBoundary = Object.freeze({
  audience: 'kite-app',
  transport: 'in-process',
  revision: 'runtime-contract-current',
  schema: RUNTIME_CONTRACT_SCHEMA_,
});

export interface RuntimeAccess {
  command(command: RuntimeCommand): Promise<RuntimeCommandReceipt>;
  query(query: RuntimeQuery): Promise<RuntimeQueryResult>;
  subscribe(subscription: RuntimeSubscription): AsyncIterable<RuntimeNotification>;
}
