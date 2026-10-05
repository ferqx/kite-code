import { createHash } from 'node:crypto';
import { canonicalJson } from '../json';
import type { Store } from '../storage/port';
import {
  AgentError,
  type ExtensionRecord,
  type ForkNamespacePage,
  type ForkNamespacePlan,
  type ForkNamespaceReport,
  type Json,
} from '../storage/types';
import { recordValidator } from './fork';
import { type TrustedForkSourceReaders, verifyForkReadonlyBodies } from './fork-source-readers';
import type { Extension } from './index';
export type PublicForkInput = Omit<Parameters<Store['forkSession']>[0], 'namespacePlan'>;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
export async function prepareNamespaceFork(
  store: Store,
  extensions: readonly Extension[],
  input: PublicForkInput,
  readers?: TrustedForkSourceReaders,
): Promise<ForkNamespacePlan | undefined> {
  if (
    !extensions.some((extension) =>
      extension.records?.some((record) => record.fork && record.fork.mode !== 'omit'),
    )
  )
    return undefined;
  let first: ForkNamespacePage | undefined, afterSeq: string | undefined;
  const sources: ForkNamespacePage['records'] = [];
  do {
    const page = await store.readForkNamespacePage({
      ...input,
      afterSeq,
      ...(first
        ? { expectedSnapshotCursor: first.snapshotCursor, expectedDataVersion: first.dataVersion }
        : {}),
    });
    first ??= page;
    sources.push(...page.records);
    afterSeq = page.nextAfterSeq ?? undefined;
  } while (afterSeq);
  const writes: ForkNamespacePlan['writes'] = [],
    report: ForkNamespaceReport[] = [];
  const groups = new Map<string, ForkNamespacePage['records']>();
  for (const row of sources) {
    const key = canonicalJson([row.extensionId, row.contentType, row.contentVersion]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const rows of groups.values()) {
    const firstRow = rows[0]!,
      extension = extensions.find((e) => e.id === firstRow.extensionId),
      definition = extension?.records?.find(
        (r) =>
          r.contentType === firstRow.contentType && r.contentVersion === firstRow.contentVersion,
      ),
      rule = definition?.fork;
    const entry: ForkNamespaceReport = {
      extensionId: firstRow.extensionId,
      contentType: firstRow.contentType,
      contentVersion: firstRow.contentVersion,
      mode: rule?.mode ?? 'omit',
      ruleVersion: rule && rule.mode !== 'omit' ? rule.version : null,
      copied: 0,
      rebuilt: 0,
      omitted: 0,
    };
    report.push(entry);
    if (!definition || !extension || !rule || rule.mode === 'omit') {
      entry.omitted = rows.length;
      continue;
    }
    const validate = recordValidator(definition.schema),
      known: ExtensionRecord[] = [];
    for (const row of rows) {
      let value: Json | undefined;
      try {
        if (row.rawText !== null) value = JSON.parse(row.rawText) as Json;
      } catch {}
      if (value === undefined || !validate(value)) {
        if (rule.onUnsupported === 'reject') throw new AgentError('fork_record_unsupported');
        entry.omitted++;
        continue;
      }
      known.push({
        extensionId: row.extensionId,
        sessionId: input.sourceSessionId,
        key: row.key,
        revision: row.revision,
        contentType: row.contentType,
        contentVersion: row.contentVersion,
        originStoreId: row.originStoreId,
        forkProvenance: row.forkProvenance,
        value,
      });
    }
    if (rule.mode === 'copy') {
      for (const record of known) {
        const original = rows.find((r) => r.key === record.key)!;
        writes.push({
          extensionId: extension.id,
          key: record.key,
          contentType: record.contentType,
          contentVersion: record.contentVersion,
          rawText: original.rawText!,
          mode: 'copy',
          ruleVersion: rule.version,
          extensionVersion: extension.version,
          sourceKeys: [record.key],
          schema: definition.schema,
        });
        entry.copied++;
      }
    } else if (known.length) {
      let namespaceRecords: ExtensionRecord[] | undefined;
      if (rule.sourceScope === 'namespace') {
        namespaceRecords = [];
        for (const row of sources.filter((source) => source.extensionId === extension.id)) {
          const registered = extension.records?.find(
            (record) =>
              record.contentType === row.contentType &&
              record.contentVersion === row.contentVersion,
          );
          let value: Json | undefined;
          try {
            if (row.rawText !== null) value = JSON.parse(row.rawText) as Json;
          } catch {}
          if (!registered || value === undefined || !recordValidator(registered.schema)(value)) {
            if (rule.onUnsupported === 'reject') throw new AgentError('fork_record_unsupported');
            continue;
          }
          namespaceRecords.push({
            extensionId: row.extensionId,
            sessionId: input.sourceSessionId,
            key: row.key,
            revision: row.revision,
            contentType: row.contentType,
            contentVersion: row.contentVersion,
            originStoreId: row.originStoreId,
            forkProvenance: row.forkProvenance,
            value,
          });
        }
        if (
          namespaceRecords.length > 64 ||
          Buffer.byteLength(canonicalJson(namespaceRecords as unknown as Json)) > 1024 * 1024
        )
          throw new AgentError('fork_namespace_too_large');
      }
      const output = await rule.prepare(
        freeze(
          structuredClone({
            sourceSessionId: input.sourceSessionId,
            targetSessionId: input.newSessionId,
            selectionId: input.expectedContextSelectionId,
            boundary: { upperSeq: first!.sourceUpperSeq },
            records: known,
            ...(namespaceRecords ? { namespaceRecords } : {}),
            selectedMessages: first!.selectedMessages,
          }),
        ),
      );
      if (!Array.isArray(output)) throw new AgentError('fork_namespace_invalid');
      for (const record of output) {
        if (
          !record ||
          Object.keys(record).some(
            (key) =>
              !['key', 'contentType', 'contentVersion', 'value', 'readonlySources'].includes(key),
          )
        )
          throw new AgentError('fork_namespace_invalid');
        const target = extension.records?.find(
          (r) => r.contentType === record.contentType && r.contentVersion === record.contentVersion,
        );
        if (!target || !recordValidator(target.schema)(record.value))
          throw new AgentError('fork_record_unsupported');
        if (record.readonlySources !== undefined && rule.sourceReads !== 'declared')
          throw new AgentError('fork_namespace_invalid');
        const readonlyProof =
          record.readonlySources === undefined
            ? undefined
            : await store.prepareForkReadonlySources({
                expectedStoreId: input.expectedStoreId,
                subjectId: input.subjectId,
                sessionId: input.sourceSessionId,
                extensionId: extension.id,
                declarations: record.readonlySources,
              });
        if (readonlyProof)
          await verifyForkReadonlyBodies(
            store,
            readers,
            readonlyProof,
            input.expectedStoreId,
            input.subjectId,
          );
        writes.push({
          ...(readonlyProof ? { readonlyProof } : {}),
          extensionId: extension.id,
          key: record.key,
          contentType: record.contentType,
          contentVersion: record.contentVersion,
          rawText: canonicalJson(record.value),
          mode: 'rebuild',
          ruleVersion: rule.version,
          extensionVersion: extension.version,
          sourceKeys: (namespaceRecords ?? known).map((r) => r.key),
          schema: target.schema,
        });
        entry.rebuilt++;
      }
    }
  }
  const plan: ForkNamespacePlan = {
    snapshotCursor: first!.snapshotCursor,
    dataVersion: first!.dataVersion,
    sourceUpperSeq: first!.sourceUpperSeq,
    selectedMessagesDigest: createHash('sha256')
      .update(canonicalJson(first!.selectedMessages as unknown as Json))
      .digest('hex'),
    sources: sources.map(({ rawText: _raw, ...source }) => source),
    writes,
    report,
  };
  if (Buffer.byteLength(JSON.stringify(plan)) > 1024 * 1024)
    throw new AgentError('fork_namespace_too_large');
  return plan;
}
