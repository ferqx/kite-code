import type { ExtensionRecord, ForkRecordOutput, Json, RecordForkRule } from '../../extensions';
import { AgentError } from '../../storage/types';
import type {
  FileCheckpoint,
  FileCheckpointForkEvent,
  FileCheckpointForkSnapshot,
  FileCheckpointRecord,
  FileCheckpointRestoreEffect,
  FileCheckpointRestoreJournal,
  FileCheckpointSnapshotRecord,
} from './types';

export const forkType = 'builtin.files.checkpoint.fork';
export const forkKey = 'checkpoint/fork/snapshot';
const maxEvents = 64;

export interface FileCheckpointForkPorts {
  namespace: string;
  pointType: string;
  headType: string;
  fileType: string;
  intentType: string;
  effectType: string;
  point(record: ExtensionRecord): FileCheckpoint;
  file(record: ExtensionRecord, checkpoint: FileCheckpoint): FileCheckpointRecord;
  decode<T>(record: ExtensionRecord, type: string): T;
}
function fail(code: string): never {
  throw new AgentError(code);
}
function metadata(record: Readonly<ExtensionRecord>): FileCheckpointSnapshotRecord {
  const { forkProvenance: _private, ...original } = record;
  return structuredClone(original);
}
/** Empty ledger precedes all physical restore/remove calls; the caller must also verify the Job. */
export function isFailedRestoreWithoutEffects(
  journal: FileCheckpointRestoreJournal,
  effects: readonly FileCheckpointSnapshotRecord[],
): boolean {
  return (
    journal.phase === 'failed' &&
    effects.length === 0 &&
    journal.files.length > 0 &&
    journal.files.every(
      (file, index) =>
        file.confirmedPost === null && file.state === (index === 0 ? 'failed' : 'not_started'),
    )
  );
}
export function fileCheckpointLocalEvents(
  records: readonly Readonly<ExtensionRecord>[],
  sourceSessionId: string,
  ports: FileCheckpointForkPorts,
): FileCheckpointForkEvent[] {
  const byKey = new Map(records.map((record) => [record.key, record]));
  if (byKey.size !== records.length) fail('checkpoint_fork_snapshot_invalid');
  const events: { seq: bigint; event: FileCheckpointForkEvent }[] = [];
  for (const record of records) {
    if (record.extensionId !== ports.namespace || record.sessionId !== sourceSessionId)
      fail('checkpoint_fork_snapshot_invalid');
    if (record.contentType === ports.pointType) {
      const checkpoint = ports.point(record);
      const head = byKey.get(`checkpoint/${checkpoint.id}/head`);
      if (!head) fail('checkpoint_capture_unconfirmed');
      const state = ports.decode<{ checkpointId: string; state: string }>(head, ports.headType);
      if (
        state.checkpointId !== checkpoint.id ||
        state.state !== 'idle' ||
        head.originStoreId !== checkpoint.boundary.storeId
      )
        fail('checkpoint_capture_unconfirmed');
      const files = records.filter((file) => {
        if (file.contentType !== ports.fileType) return false;
        const value = ports.decode<FileCheckpointRecord>(file, ports.fileType);
        if (value.checkpointId !== checkpoint.id) return false;
        ports.file(file, checkpoint);
        if (value.state !== 'captured' || value.pending || !value.first || !value.last)
          fail('checkpoint_capture_unconfirmed');
        return true;
      });
      if (!files.length) fail('checkpoint_capture_unconfirmed');
      events.push({
        seq: BigInt(checkpoint.boundary.triggerSeq),
        event: {
          kind: 'capture',
          point: metadata(record),
          head: metadata(head),
          files: files.map(metadata),
        },
      });
    } else if (record.contentType === ports.intentType) {
      const value = ports.decode<{ phase: string }>(record, ports.intentType);
      if (value.phase === 'blocked') continue;
      if (record.contentVersion !== 2) fail('checkpoint_restore_unconfirmed');
      const journal = value as FileCheckpointRestoreJournal;
      const effects = records
        .filter((entry) => {
          if (entry.contentType !== ports.effectType) return false;
          const effect = ports.decode<FileCheckpointRestoreEffect>(entry, ports.effectType);
          return effect.restoreId === journal.id;
        })
        .map(metadata);
      if (
        !isFailedRestoreWithoutEffects(journal, effects) &&
        (journal.phase !== 'restored' ||
          !journal.files.every(
            (file) =>
              ['restored', 'removed', 'unchanged'].includes(file.state) && file.confirmedPost,
          ))
      )
        fail('checkpoint_restore_unconfirmed');
      events.push({
        seq: BigInt(journal.rootWorkSeq),
        event: {
          kind: 'restore',
          journal: metadata(record),
          effects,
        },
      });
    }
  }
  events.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  if (events.some((event, index) => index > 0 && event.seq === events[index - 1]!.seq))
    fail('checkpoint_fork_snapshot_invalid');
  return events.map(({ event }) => event);
}
export function fileCheckpointForkRule(ports: FileCheckpointForkPorts): RecordForkRule {
  function declare(
    events: readonly FileCheckpointForkEvent[],
    inherited: boolean,
  ): NonNullable<ForkRecordOutput['readonlySources']> {
    const selected = new Map<
      string,
      { executionId: string; kind: 'tool' | 'job'; refs: Set<string> }
    >();
    const add = (executionId: string, kind: 'tool' | 'job', refs: readonly string[] = []) => {
      const original = selected.get(executionId);
      if (original && original.kind !== kind) fail('checkpoint_fork_snapshot_invalid');
      if (!original) selected.set(executionId, { executionId, kind, refs: new Set(refs) });
      else for (const ref of refs) original.refs.add(ref);
    };
    for (const event of events) {
      if (event.kind === 'capture') {
        const checkpoint = ports.point(event.point);
        for (const record of event.files) {
          const file = ports.file(record, checkpoint);
          if (!file.first || !file.last || file.pending || file.state !== 'captured')
            fail('checkpoint_capture_unconfirmed');
          add(
            file.first.source.executionId,
            'tool',
            file.first.artifact ? [file.first.artifact.id] : [],
          );
          add(file.last.source.executionId, 'tool');
        }
      } else {
        const journal = ports.decode<FileCheckpointRestoreJournal>(event.journal, ports.intentType);
        add(
          journal.executionId,
          'job',
          event.effects.flatMap((record) => {
            const effect = ports.decode<FileCheckpointRestoreEffect>(record, ports.effectType);
            return effect.beforeImage ? [effect.beforeImage.id] : [];
          }),
        );
      }
    }
    return [...selected.values()].map(({ executionId, kind, refs }) =>
      inherited
        ? { kind: 'inherited', anchorKey: forkKey, executionId, artifactRefIds: [...refs].sort() }
        : { kind: 'execution', executionId, executionKind: kind, artifactRefIds: [...refs].sort() },
    );
  }
  return {
    mode: 'rebuild',
    version: '1',
    sourceScope: 'namespace',
    sourceReads: 'declared',
    onUnsupported: 'reject',
    async prepare(input) {
      if (!input.namespaceRecords) fail('checkpoint_fork_snapshot_unavailable');
      const hasHeads = input.namespaceRecords.some(
        (record) => record.contentType === ports.headType,
      );
      const sourceType = input.records[0]?.contentType;
      if ((sourceType === forkType && hasHeads) || (sourceType === ports.headType && !hasHeads))
        return [];
      if (![forkType, ports.headType].includes(sourceType ?? ''))
        fail('checkpoint_fork_snapshot_invalid');
      const old = input.namespaceRecords.filter((record) => record.contentType === forkType);
      if (old.length > 1 || (old[0] && old[0].key !== forkKey))
        fail('checkpoint_fork_snapshot_invalid');
      const inherited = old[0]
        ? ports.decode<FileCheckpointForkSnapshot>(old[0], forkType).events
        : [];
      const local = fileCheckpointLocalEvents(input.namespaceRecords, input.sourceSessionId, ports);
      const events = [...inherited, ...local];
      if (events.length > maxEvents) fail('checkpoint_fork_snapshot_budget_exceeded');
      if (!events.length) return [];
      return [
        {
          key: forkKey,
          contentType: forkType,
          contentVersion: 1,
          value: { events } as unknown as Json,
          readonlySources: [...declare(inherited, true), ...declare(local, false)],
        },
      ];
    },
  };
}
