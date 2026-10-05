import {
  canonicalFileRecoveryIntent,
  type FileRecoveryIntent,
  parseFileRecoveryIntent,
} from '@kite-ai/client/file-recovery-intent';
import {
  assertAnswerRecords,
  type NativeAnswerRecord,
  validateAnswerRecord,
} from '../electron/answer-journal';
import { callerCanonical, validateCallerRecord } from '../electron/caller-journal';
import {
  assertFileRecoveryTransition,
  fileRecoveryIntentId,
} from '../electron/file-recovery-journal';
import type { DraftScope, PrivateData } from '../electron/private-data';
import type {
  NativeCallerRecord,
  NativeCreation,
  NativeDraft,
  NativeRecoveryIntent,
} from '../src/native-bridge';
/** Explicit unit port. Production main always opens the Node private file. */
export function memoryPrivateData(): PrivateData {
  const files = new Map<string, FileRecoveryIntent>();
  const answers = new Map<string, NativeAnswerRecord>();
  const drafts = new Map<string, NativeDraft>(),
    creations = new Map<string, NativeCreation>(),
    recoveries = new Map<string, NativeRecoveryIntent>(),
    callers = new Map<string, NativeCallerRecord>();
  const read = (scope: DraftScope) =>
    drafts.get(JSON.stringify(scope)) ?? {
      id: JSON.stringify(scope),
      ...scope,
      content: '',
      revision: 0,
    };
  return {
    answers: () => [...answers.values()].map((row) => structuredClone(row)),
    beginAnswer(raw) {
      const value = validateAnswerRecord(raw),
        old = answers.get(value.intent.request.commandId);
      if (old) {
        if (callerCanonical(old.intent) !== callerCanonical(value.intent))
          throw Error('answer_intent_conflict');
        return { created: false, value: structuredClone(old) };
      }
      assertAnswerRecords([...answers.values(), value]);
      answers.set(value.intent.request.commandId, structuredClone(value));
      return { created: true, value };
    },
    finishAnswer(id, phase) {
      const old = answers.get(id);
      if (!old) throw Error('answer_intent_missing');
      const value = validateAnswerRecord({ ...old, phase });
      answers.set(id, value);
      return structuredClone(value);
    },
    read,
    save(scope, revision, content) {
      const previous = read(scope);
      if (revision !== previous.revision) throw Error('draft_revision_conflict');
      const value = { ...previous, revision: revision + 1, content };
      drafts.set(JSON.stringify(scope), value);
      return value;
    },
    list() {
      return { drafts: [...drafts.values()], nextId: null };
    },
    readId(id) {
      for (const draft of drafts.values()) if (draft.id === id) return draft;
      throw Error('draft_not_found');
    },
    creations() {
      return [...creations.values()];
    },
    begin(input) {
      const old = creations.get(input.commandId);
      if (old) {
        if (JSON.stringify(old.input) !== JSON.stringify(input))
          throw Error('creation_intent_conflict');
        return { created: false, value: old };
      }
      const value: NativeCreation = { input, phase: 'pending' };
      creations.set(input.commandId, value);
      return { created: true, value };
    },
    finish(id, phase, code) {
      const old = creations.get(id)!;
      const value = { ...old, phase, code };
      creations.set(id, value);
      return value;
    },
    recoveries() {
      return [...recoveries.values()].filter((value) =>
        ['submitting', 'accepted', 'outcome_unknown'].includes(value.phase),
      );
    },
    beginRecovery(input) {
      const old = recoveries.get(input.commandId);
      if (old) return { created: false, value: old };
      recoveries.set(input.commandId, structuredClone(input));
      return { created: true, value: input };
    },
    finishRecovery(id, phase, error) {
      const old = recoveries.get(id)!;
      const value = { ...old, phase, ...(error ? { error } : {}) };
      recoveries.set(id, value);
      return value;
    },
    callers() {
      return [...callers.values()].map((r) => structuredClone(r));
    },
    beginCaller(row) {
      const value = validateCallerRecord(row),
        old = callers.get(value.intent.request.commandId);
      if (old) {
        if (callerCanonical(old.intent) !== callerCanonical(value.intent))
          throw Error('caller_intent_conflict');
        return { created: false, value: old };
      }
      if (callers.size >= 128) throw Error('caller_capacity_exceeded');
      callers.set(value.intent.request.commandId, value);
      return { created: true, value };
    },
    finishCaller(commandId, phase) {
      const old = callers.get(commandId);
      if (!old) throw Error('caller_intent_missing');
      if (['applied', 'rejected'].includes(old.phase)) return old;
      const value = { ...old, phase };
      callers.set(commandId, value);
      return value;
    },
    clearCaller(commandId) {
      const row = callers.get(commandId);
      if (!row || !['applied', 'rejected'].includes(row.phase))
        throw Error('caller_clear_unconfirmed');
      callers.delete(commandId);
    },
    async fileRecoveries() {
      return Promise.all([...files.values()].map(parseFileRecoveryIntent));
    },
    async prepareFileRecovery(input) {
      const value = await parseFileRecoveryIntent(input),
        id = fileRecoveryIntentId(value),
        old = files.get(id);
      if (old) {
        if (canonicalFileRecoveryIntent(old) !== canonicalFileRecoveryIntent(value))
          throw Error('file_recovery_intent_conflict');
        return { created: false, value: old };
      }
      files.set(id, value);
      return { created: true, value };
    },
    async updateFileRecovery(input, previous) {
      const value = await parseFileRecoveryIntent(input),
        id = fileRecoveryIntentId(value),
        old = files.get(id);
      if (
        !old ||
        canonicalFileRecoveryIntent(old) !== canonicalFileRecoveryIntent(previous) ||
        old.code?.phase !== previous.code?.phase ||
        old.fork?.phase !== previous.fork?.phase
      )
        throw Error('file_recovery_phase_conflict');
      assertFileRecoveryTransition(old, value);
      files.set(id, value);
      return value;
    },
    close() {},
  };
}
