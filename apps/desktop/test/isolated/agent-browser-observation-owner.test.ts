import { setTimeout as fixtureDelay } from 'node:timers/promises';
import { expect, test } from '#kite-test';
import { createAgentBrowserObservationOwner } from '../../src/agent-browser-observation-owner';
import { browserFixture, browserScope } from '../agent-browser.fixture';

async function until(check: () => boolean) {
  const end = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > end) throw Error('shared_owner_timeout');
    await fixtureDelay(5);
  }
}
test('same-scope picker and toolbar share one Main catalogue; picker closure never revokes the live control observation', async () => {
  const f = browserFixture();
  let fresh = false,
    readonlyFresh = false;
  const controls = createAgentBrowserObservationOwner(
    f.bridge,
    browserScope,
    (state) => {
      fresh = state.fresh;
    },
    true,
  );
  const notes = createAgentBrowserObservationOwner(
    f.bridge,
    browserScope,
    (state) => {
      readonlyFresh = state.fresh;
    },
    false,
  );
  try {
    controls.start(true);
    await until(() => fresh);
    const opened = f.calls.filter((call) => call.method === 'extensions.open').length;
    notes.start(true);
    await until(() => readonlyFresh);
    expect(f.calls.filter((call) => call.method === 'extensions.open')).toHaveLength(opened);
    expect(
      await notes.invoke('handoff', { browserId: f.view.browserId, generation: f.view.generation }),
    ).toBe(false);
    notes.setVisible(false);
    notes.stop();
    expect(fresh).toBe(true);
    expect(
      await controls.invoke('handoff', {
        browserId: f.view.browserId,
        generation: f.view.generation,
      }),
    ).toBe(true);
    await until(() => fresh);
    expect(f.submitted).toHaveLength(1);
    expect(f.submitted[0]?.actionId).toBe('browser.handoff');
    expect(f.records).toHaveLength(1);
  } finally {
    notes.stop();
    controls.stop();
  }
});
test('late cleanup of old-scope subscribers cannot release or reactivate the new scope catalogue', async () => {
  const f = browserFixture();
  let oldFresh = false,
    newFresh = false;
  const first = createAgentBrowserObservationOwner(
    f.bridge,
    browserScope,
    (state) => {
      oldFresh = state.fresh;
    },
    true,
  );
  const notes = createAgentBrowserObservationOwner(f.bridge, browserScope, () => {}, false);
  const scope = { ...browserScope, viewSelection: 2, sessionId: 'other' };
  const second = createAgentBrowserObservationOwner(
    f.bridge,
    scope,
    (state) => {
      newFresh = state.fresh;
    },
    true,
  );
  try {
    first.start(true);
    notes.start(true);
    await until(() => oldFresh);
    f.scope = scope;
    second.start(true);
    await until(() => newFresh);
    expect(oldFresh).toBe(false);
    const releases = f.calls.filter((call) => call.method === 'extensions.release').length;
    notes.stop();
    first.setCanInvoke(false);
    first.stop();
    expect(f.calls.filter((call) => call.method === 'extensions.release')).toHaveLength(releases);
    expect(newFresh).toBe(true);
    expect(
      await second.invoke('close', { browserId: f.view.browserId, generation: f.view.generation }),
    ).toBe(true);
    await until(() => newFresh);
    expect(f.submitted).toHaveLength(1);
    expect(f.records[0]?.intent.scope.sessionId).toBe('other');
  } finally {
    notes.stop();
    first.stop();
    second.stop();
  }
});
