/** Exact historical maintenance owners may name the durable formats they verify. */
const historicalSessionReadOwners = new Set([
  'packages/agent-kernel/src/state-migration.ts',
  'packages/agent-kernel/src/state-codec.ts',
  'packages/agent-kernel/src/index.ts',
  'packages/runtime-host/src/storage/index.ts',
  'packages/runtime-host/src/format/storage-binding.ts',
  'packages/runtime-storage-sqlite/src/compatibility.ts',
  'packages/runtime-storage-sqlite/src/index.ts',
  'apps/kite-service/src/bootstrap/runtime/state-store-compatibility.ts',
  'apps/kite-service/src/runtime-client/history-adapter.ts',
  'apps/kite-service/src/bootstrap.ts',
]);

const historicalProcessAdmissionOwners = new Set([
  'packages/kite-local-runtime/src/service/legacy-store-processes.ts',
  'packages/kite-local-runtime/src/service/installed-store-admission.ts',
]);

const storeFormatOwners = new Set([
  'kite-home-store.ts',
  'kite-session-agent-schema.ts',
  'kite-session-runtime-file.ts',
]);
const storeConversionModule =
  /^kite-session-store(?:9-conversion|10-to11|11-conversion|11-to12|12-to13|13-to14|14-to15|15-to16)\.ts$/u;
const storageSourcePrefix = 'packages/runtime-storage-sqlite/src/';

const activeStoreContractOwners = new Set([
  'docs/active/private-artifact-storage.md',
  'docs/active/sqlite-runtime-log-query.md',
]);

const versionedPath = /(?:^|[/_.-])(?:v\d+|state\d+|store\d+|rmv\d+|rav\d+)(?:[/_.-]|$)/iu;
const versionedEntity = /(?:V\d+|State\d+|Store\d+|RMV\d+|RAV\d+)/iu;
const historicalEntity = /(?:Legacy|Compat)/u;

export function ownsHistoricalStoreFormat(relativePath: string): boolean {
  if (!relativePath.startsWith(storageSourcePrefix)) return false;
  const name = relativePath.slice(storageSourcePrefix.length);
  return storeFormatOwners.has(name) || storeConversionModule.test(name);
}

export function violatesVersionedProductionPath(relativePath: string): boolean {
  return versionedPath.test(relativePath) && !ownsHistoricalStoreFormat(relativePath);
}

export function violatesHistoricalProductionEntity(relativePath: string, name: string): boolean {
  const withoutAlgorithmNames = name.replace(/IPv[46]|SHA(?:1|256|512)/giu, '');
  // This exact factory names an external protocol, not a historical runtime branch.
  if (
    relativePath === 'packages/ai/src/sdk.ts' &&
    name === 'createCompatibleModelBinding' &&
    !versionedEntity.test(withoutAlgorithmNames)
  )
    return false;
  if (!versionedEntity.test(withoutAlgorithmNames) && !historicalEntity.test(name)) return false;
  return (
    !historicalSessionReadOwners.has(relativePath) &&
    !historicalProcessAdmissionOwners.has(relativePath) &&
    !ownsHistoricalStoreFormat(relativePath)
  );
}

export function violatesActiveDocumentationVersion(relativePath: string, source: string): boolean {
  if (/\b(?:State|RMV|RAV)\d+\b/u.test(source)) return true;
  return /\bStore\d+\b/u.test(source) && !activeStoreContractOwners.has(relativePath);
}
