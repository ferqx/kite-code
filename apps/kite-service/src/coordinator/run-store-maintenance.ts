import {
  isRuntimeHostStateSettledForMigration,
  type StateRuntimeState,
} from '@kite-ai/runtime-host';

/**
 * Service-owned convergence predicate for the Store 7 → Store 8 offline boundary.
 *
 * The SQLite owner separately proves there are no effect leases and that durable authority tables
 * have settled. This projection closes the State half of the barrier: a terminal Turn alone is not
 * sufficient when an interaction, unknown external result, cleanup authority, or recovery journal
 * remains unresolved.
 */
export function isRunStoreMigrationSessionSettled(state: Readonly<StateRuntimeState>): boolean {
  return isRuntimeHostStateSettledForMigration(state);
}
