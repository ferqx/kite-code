import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireProfileAccess } from '@kite-ai/agent/profile-access';
import { waitForTuiProfileAccess } from '../../../apps/cli/host/tui-startup-wait';
import { acquireProfileMaintenanceAccess } from '../../../packages/agent/src/platform/profile';

function fixture() {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-startup-lock-')));
  const profile = { dataRoot, profile: 'test' };
  const holder = acquireProfileMaintenanceAccess(profile);
  return {
    profile,
    holder,
    cleanup() {
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('actual maintenance exclusion waits once and admits the same Profile after its owner releases', async () => {
  const f = fixture();
  let notices = 0;
  try {
    const waiting = waitForTuiProfileAccess(f.profile, {
      onWait() {
        notices++;
        f.holder.lock.release();
      },
    });
    const access = await waiting;
    expect(notices).toBe(1);
    expect(access.databasePath).toBe(join(f.profile.dataRoot, 'test', 'core.db'));
    access.lock.release();
  } finally {
    f.cleanup();
  }
});

test('startup cancellation leaves the independent maintenance owner untouched and opens no shared lease', async () => {
  const f = fixture(),
    exit = new AbortController();
  try {
    const waiting = waitForTuiProfileAccess(f.profile, {
      signal: exit.signal,
      onWait() {
        exit.abort(new Error('test_cancelled'));
      },
    });
    await expect(waiting).rejects.toThrow('test_cancelled');
    expect(() => acquireProfileAccess(f.profile)).toThrow('busy');
  } finally {
    f.holder.lock.release();
    f.cleanup();
  }
});

test('bounded wait does not reinterpret a restore journal as retryable contention', async () => {
  const f = fixture();
  let notices = 0;
  f.holder.lock.release();
  writeFileSync(join(f.holder.coordinationPath, 'restore-journal.json'), '{}');
  try {
    await expect(
      waitForTuiProfileAccess(f.profile, {
        onWait() {
          notices++;
        },
      }),
    ).rejects.toThrow('restore_reconciliation_required');
    expect(notices).toBe(0);
  } finally {
    f.cleanup();
  }
});

test('bounded startup timeout retains the maintenance owner and fails honestly', async () => {
  const f = fixture();
  try {
    await expect(waitForTuiProfileAccess(f.profile, { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'tui_startup_wait_timeout',
    });
    expect(() => acquireProfileAccess(f.profile)).toThrow('busy');
  } finally {
    f.holder.lock.release();
    f.cleanup();
  }
});
