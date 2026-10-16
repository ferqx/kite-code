import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../src/json';
import { verifyDesktopCallerRows } from '../../../src/maintenance/desktop-callers';
import type { Json } from '../../../src/storage';

function fixture(kind: 'run.start' | 'input.follow_up', effort?: Json) {
  const db = new Database(':memory:');
  db.run('CREATE TABLE caller_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)');
  const request = {
    kind,
    expectedStoreId: 'original_store',
    commandId: 'original_command',
    content: 'Original effort é🙂\r\n',
    modelId: 'original_model',
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(kind === 'input.follow_up'
      ? { afterRunId: null, contextSelectionId: 'original_context' }
      : {}),
  };
  const digest = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const { expectedStoreId: _store, commandId: _command, ...body } = request;
  const row = {
    intent: {
      scope: { storeId: 'original_store', workspaceId: 'w', sessionId: 'original_session' },
      subjectId: 'original_subject',
      request,
      target:
        kind === 'run.start'
          ? { kind: 'session', id: 'original_session' }
          : { kind: 'after_run', id: null, contextSelectionId: 'original_context' },
      bodyDigest: digest(request),
      requestDigest: digest(body),
    },
    phase: 'unknown',
  };
  const text = JSON.stringify(row);
  db.query('INSERT INTO caller_intents VALUES(?,?)').run(request.commandId, text);
  return { db, text, row };
}

test('actual SQLite caller reads preserve all six effort values and existing none/minimal bytes', () => {
  for (const kind of ['run.start', 'input.follow_up'] as const) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultar', 'none', 'minimal']) {
      const f = fixture(kind, effort);
      try {
        verifyDesktopCallerRows(f.db, true);
        expect(
          f.db.query<{ state: string }, []>('SELECT state FROM caller_intents').get()!.state,
        ).toBe(f.text);
        expect(() => verifyDesktopCallerRows(f.db)).toThrow('backup_ui_invalid');
      } finally {
        f.db.close(true);
      }
    }
  }
});

test('historical caller grammar still reads requests without effort', () => {
  const f = fixture('run.start');
  try {
    verifyDesktopCallerRows(f.db);
    expect(f.db.query<{ state: string }, []>('SELECT state FROM caller_intents').get()!.state).toBe(
      f.text,
    );
  } finally {
    f.db.close(true);
  }
});

test('unrecognized spelling and invalid effort types reject even with matching original request digests', () => {
  for (const effort of ['ultra', 'extreme', ['ultar'], 5, null]) {
    const f = fixture('run.start', effort);
    try {
      expect(() => verifyDesktopCallerRows(f.db, true)).toThrow('backup_ui_invalid');
      expect(
        f.db.query<{ state: string }, []>('SELECT state FROM caller_intents').get()!.state,
      ).toBe(f.text);
    } finally {
      f.db.close(true);
    }
  }
});
