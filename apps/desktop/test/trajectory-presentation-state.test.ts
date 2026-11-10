import { expect, test } from 'bun:test';
import { initialTrajectoryViewState } from '@kite-ai/ui/desktop';
import { mergeTrajectoryPresentation } from '../src/trajectory-presentation-state';

const integrity = {
  facts: 'complete' as const,
  identityConfidence: 'verified_origin' as const,
  reasons: [],
};
function state(upperCursor: string) {
  return initialTrajectoryViewState({
    storeId: 'store',
    sessionId: 'session',
    upperCursor,
    formatVersion: 1,
    historyCoverage: { enabledAfterCursor: '0', upperCursor, status: 'retained', integrity },
  });
}

test('independent combination filter callbacks merge only their deltas and reject old reading positions', () => {
  const rendered = state('23');
  const first = mergeTrajectoryPresentation(rendered, rendered, {
    ...rendered,
    filters: { ...rendered.filters!, duration: 'observed_ge_1s' },
  });
  const second = mergeTrajectoryPresentation(first, rendered, {
    ...rendered,
    filters: { ...rendered.filters!, subcalls: 'child' },
    readingAnchor: { eventId: 'old', offset: 10, scrollTop: 600 },
  });
  expect(second.filters?.duration).toBe('observed_ge_1s');
  expect(second.filters?.subcalls).toBe('child');
  expect(second.readingAnchor).toEqual(rendered.readingAnchor);
});

test('independent folding toggles merge their own changes across queued renders', () => {
  const rendered = state('23');
  const first = mergeTrajectoryPresentation(rendered, rendered, {
    ...rendered,
    expansion: { ...rendered.expansion!, rounds: false },
  });
  const second = mergeTrajectoryPresentation(first, rendered, {
    ...rendered,
    expansion: { ...rendered.expansion!, subcalls: true },
  });
  expect(second.expansion).toEqual({ rounds: false, calls: true, subcalls: true });
  const third = mergeTrajectoryPresentation(second, rendered, {
    ...rendered,
    expandedNodeIds: ['run:run'],
  });
  expect(third.expansion).toEqual(second.expansion);
  expect(third.expandedNodeIds).toEqual(['run:run']);
  expect(third.cursor).toBe('23');
});

test('a retained child detail target follows selection and rejects a stale node or reader', () => {
  const rendered = { ...state('23'), selectedNodeId: 'execution:parent-tool' };
  const target = {
    nodeId: 'child-scope:execution:tool',
    parentNodeId: 'execution:carrier',
    sessionId: 'child-session',
    runId: 'child-run',
  };
  const selected = mergeTrajectoryPresentation(rendered, rendered, {
    ...rendered,
    selectedNodeId: target.nodeId,
    selectedRelatedScope: target,
  });
  expect(selected.selectedRelatedScope).toEqual(target);
  const stale = mergeTrajectoryPresentation(selected, rendered, {
    ...rendered,
    selectedRelatedScope: null,
    detailWidth: 52,
  });
  expect(stale.selectedRelatedScope).toEqual(target);
  expect(stale.detailWidth).toBe(52);
  const restored = { ...selected, descriptor: structuredClone(selected.descriptor) };
  const folded = mergeTrajectoryPresentation(restored, selected, {
    ...selected,
    collapsedNodeIds: [target.parentNodeId],
  });
  expect(folded.selectedRelatedScope).toEqual(target);
  const changedReader = { ...folded, cursor: '22' };
  expect(
    mergeTrajectoryPresentation(changedReader, selected, {
      ...selected,
      selectedRelatedScope: null,
    }).selectedRelatedScope,
  ).toEqual(target);
  expect(
    mergeTrajectoryPresentation(folded, folded, {
      ...folded,
      selectedNodeId: 'execution:parent-tool',
      selectedRelatedScope: null,
    }).selectedRelatedScope,
  ).toBeNull();
});

test('a stale result tab scroll cannot replace the current parameters tab; width can merge independently', () => {
  const rendered = {
    ...state('23'),
    selectedNodeId: 'execution:tool',
    workbenchTab: 'result' as const,
    detailOpen: true,
    detailScrollTop: 70,
  };
  const current = { ...rendered, workbenchTab: 'parameters' as const };
  const merged = mergeTrajectoryPresentation(current, rendered, {
    ...rendered,
    detailScrollTop: 900,
    detailWidth: 52,
  });
  expect(merged.workbenchTab).toBe('parameters');
  expect(merged.detailScrollTop).toBe(70);
  expect(merged.detailWidth).toBe(52);
  expect(merged.selectedNodeId).toBe('execution:tool');
});

test('return latest keeps newly committed descriptor/cursor when a prior render selects all events', () => {
  const rendered = { ...state('3'), mode: 'replay' as const };
  const latest = { ...state('23'), mode: 'live' as const, pageAfterCursor: '0' };
  const result = mergeTrajectoryPresentation(latest, rendered, {
    ...rendered,
    listMode: 'all_events',
  });
  expect(result).toEqual({ ...latest, listMode: 'all_events' });
});
test('a mode selection during held loading survives the commit and its older queued scroll callback', () => {
  const rendered = { ...state('3'), mode: 'history' as const };
  const duringLoad = mergeTrajectoryPresentation(rendered, rendered, {
    ...rendered,
    listMode: 'all_events',
  });
  const latest = {
    ...duringLoad,
    descriptor: state('23').descriptor,
    cursor: '23',
    mode: 'live' as const,
    pageAfterCursor: '0',
  };
  const result = mergeTrajectoryPresentation(latest, rendered, {
    ...rendered,
    readingAnchor: { eventId: 'old-2', offset: 8, scrollTop: 900 },
  });
  expect(result).toBe(latest);
  expect(result.listMode).toBe('all_events');
  expect(result.cursor).toBe('23');
});
test('same-filter anchor updates merge with an independent tree collapse without reverting it', () => {
  const rendered = { ...state('23'), listMode: 'all_events' as const };
  const selected = { ...rendered, collapsedNodeIds: ['execution:parent'] };
  const result = mergeTrajectoryPresentation(selected, rendered, {
    ...rendered,
    readingAnchor: { eventId: 'event-20', offset: -4, scrollTop: 640 },
  });
  expect(result.listMode).toBe('all_events');
  expect(result.collapsedNodeIds).toEqual(['execution:parent']);
  expect(result.readingAnchor).toEqual({ eventId: 'event-20', offset: -4, scrollTop: 640 });
  expect(result.descriptor).toBe(selected.descriptor);
});
test('same-reader disclosures update only presentation and cannot overwrite owner reading position', () => {
  const rendered = state('23');
  const current = { ...rendered, mode: 'replay' as const };
  const result = mergeTrajectoryPresentation(current, rendered, {
    ...rendered,
    mode: 'live',
    cursor: '3',
    pageAfterCursor: '2',
    expandedEventIds: ['event-20'],
    selectedEventId: 'event-20',
  });
  expect(result).toEqual({
    ...current,
    expandedEventIds: ['event-20'],
    selectedEventId: 'event-20',
  });
});

test('a node selection and its tabs cannot publish an older node detail anchor or disclosure', () => {
  const rendered = { ...state('23'), selectedNodeId: 'execution:a', detailScrollTop: 40 };
  const selected = mergeTrajectoryPresentation(rendered, rendered, {
    ...rendered,
    selectedNodeId: 'execution:b',
  });
  const result = mergeTrajectoryPresentation(selected, rendered, {
    ...rendered,
    detailScrollTop: 800,
    expandedEventIds: ['event-a'],
    selectedEventId: 'event-a',
  });
  expect(result).toBe(selected);
  expect(result.selectedNodeId).toBe('execution:b');
  expect(result.detailScrollTop).toBe(40);
});

test('tab and tree expansion choices survive a held reader commit without reverting its cursor', () => {
  const rendered = state('3');
  const latest = { ...state('23'), mode: 'live' as const, pageAfterCursor: '0' };
  const result = mergeTrajectoryPresentation(latest, rendered, {
    ...rendered,
    detailTab: 'input',
    collapsedNodeIds: ['execution:parent'],
    selectedNodeId: 'execution:old',
    detailScrollTop: 900,
  });
  expect(result).toEqual({
    ...latest,
    detailTab: 'input',
    collapsedNodeIds: ['execution:parent'],
  });
});

test.each([
  'input',
  'lifecycle',
] as const)('a late %s tab scroll or disclosure cannot overwrite the current output tab', (detailTab) => {
  const rendered = {
    ...state('23'),
    selectedNodeId: 'execution:a',
    detailTab,
    detailScrollTop: 0,
  };
  const current = { ...rendered, detailTab: 'output' as const };
  const result = mergeTrajectoryPresentation(current, rendered, {
    ...rendered,
    detailScrollTop: 180,
    expandedEventIds: ['event-a'],
    selectedEventId: 'event-a',
  });
  expect(result).toBe(current);
  expect(result.detailScrollTop).toBe(0);
  expect(result.expandedEventIds).toEqual([]);
  expect(result.selectedEventId).toBeNull();
});

test('old node tab choices cannot switch the new node, while its independent tree collapse can apply', () => {
  const rendered = { ...state('23'), selectedNodeId: 'execution:a' };
  const current = { ...rendered, selectedNodeId: 'execution:b' };
  const result = mergeTrajectoryPresentation(current, rendered, {
    ...rendered,
    detailTab: 'input',
    collapsedNodeIds: ['execution:parent'],
  });
  expect(result).toEqual({ ...current, collapsedNodeIds: ['execution:parent'] });
});

test('tabs and tree collapse reject callbacks from a different source scope', () => {
  const rendered = state('23');
  const current = {
    ...rendered,
    descriptor: { ...rendered.descriptor!, sessionId: 'different-session' },
  };
  const result = mergeTrajectoryPresentation(current, rendered, {
    ...rendered,
    detailTab: 'input',
    collapsedNodeIds: ['execution:parent'],
  });
  expect(result).toBe(current);
});

test('a filter change rejects old lifecycle and tree scroll callbacks from the prior event domain', () => {
  const rendered = {
    ...state('23'),
    listMode: 'all_events' as const,
    selectedNodeId: 'session',
    detailScrollTop: 90,
  };
  const current = { ...rendered, listMode: 'key_steps' as const, detailScrollTop: 0 };
  const result = mergeTrajectoryPresentation(current, rendered, {
    ...rendered,
    detailScrollTop: 800,
    selectedEventId: 'old-management-event',
    expandedEventIds: ['old-management-event'],
    readingAnchor: { eventId: 'old-node', offset: 7, scrollTop: 600 },
  });
  expect(result).toBe(current);
  expect(result.listMode).toBe('key_steps');
  expect(result.detailScrollTop).toBe(0);
});

test('request selection and its four tabs survive the presentation merge without changing reader authority', () => {
  const rendered = { ...state('23'), selectedNodeId: 'execution:model' };
  let selected = mergeTrajectoryPresentation(rendered, rendered, {
    ...rendered,
    selectedRequestId: 'execution:model',
    requestTab: 'overview',
    detailOpen: true,
    detailScrollTop: 0,
    cursor: '1',
    descriptor: state('1').descriptor,
    pageAfterCursor: '1',
  });
  expect(selected.selectedRequestId).toBe('execution:model');
  expect(selected.requestTab).toBe('overview');
  expect(selected.detailOpen).toBe(true);
  expect(selected.descriptor).toBe(rendered.descriptor);
  expect(selected.cursor).toBe('23');
  expect(selected.pageAfterCursor).toBe(rendered.pageAfterCursor);
  for (const requestTab of ['options', 'usage', 'timing', 'overview'] as const) {
    selected = mergeTrajectoryPresentation(selected, selected, {
      ...selected,
      requestTab,
      detailScrollTop: 0,
    });
    expect(selected.requestTab).toBe(requestTab);
    expect(selected.selectedRequestId).toBe('execution:model');
  }
  const content = mergeTrajectoryPresentation(selected, selected, {
    ...selected,
    selectedRequestId: null,
    selectedNodeId: 'execution:model:part:reply',
    workbenchTab: 'content',
  });
  expect(content.selectedRequestId).toBeNull();
  expect(content.selectedNodeId).toBe('execution:model:part:reply');
  expect(content.workbenchTab).toBe('content');
});

test('stale node callbacks cannot overwrite a request inspector even when the original node ID is unchanged', () => {
  const rendered = {
    ...state('23'),
    selectedNodeId: 'execution:model',
    detailOpen: true,
    detailScrollTop: 45,
  };
  const current = {
    ...rendered,
    selectedRequestId: 'execution:model',
    requestTab: 'usage' as const,
    detailScrollTop: 0,
  };
  const merged = mergeTrajectoryPresentation(current, rendered, {
    ...rendered,
    selectedNodeId: 'execution:other',
    workbenchTab: 'content',
    detailOpen: false,
    selectedObservationId: 'old-node-event',
    detailScrollTop: 900,
    detailWidth: 55,
  });
  expect(merged).toEqual({ ...current, detailWidth: 55 });
});

test('stale request callbacks cannot revive request mode after ordinary content selection', () => {
  const rendered = {
    ...state('23'),
    selectedNodeId: 'execution:model',
    selectedRequestId: 'execution:model',
    requestTab: 'overview' as const,
    detailOpen: true,
  };
  const current = mergeTrajectoryPresentation(rendered, rendered, {
    ...rendered,
    selectedRequestId: null,
    workbenchTab: 'thinking',
    detailScrollTop: 0,
  });
  const merged = mergeTrajectoryPresentation(current, rendered, {
    ...rendered,
    selectedRequestId: 'execution:other',
    selectedNodeId: 'execution:other',
    requestTab: 'timing',
    detailOpen: false,
    selectedObservationId: 'old-attempt',
    detailScrollTop: 900,
  });
  expect(merged).toBe(current);
});

test('old request tab and attempt scroll callbacks cannot replace the current detail anchor', () => {
  const rendered = {
    ...state('23'),
    selectedNodeId: 'execution:model',
    selectedRequestId: 'execution:model',
    requestTab: 'options' as const,
    detailOpen: true,
    detailScrollTop: 40,
  };
  const current = { ...rendered, requestTab: 'usage' as const };
  expect(
    mergeTrajectoryPresentation(current, rendered, {
      ...rendered,
      requestTab: 'timing',
      detailScrollTop: 800,
    }),
  ).toBe(current);
  const observation = { ...current, selectedObservationId: 'later-attempt' };
  expect(
    mergeTrajectoryPresentation(observation, current, { ...current, detailScrollTop: 900 }),
  ).toBe(observation);
  expect(
    mergeTrajectoryPresentation(current, current, { ...current, detailScrollTop: 77 })
      .detailScrollTop,
  ).toBe(77);
});

test('request selection rejects old cursor, filter and source readers while independent width still merges for the same source', () => {
  const rendered = { ...state('23'), selectedNodeId: 'execution:model' };
  const update = {
    ...rendered,
    selectedRequestId: 'execution:model',
    requestTab: 'options' as const,
    detailOpen: true,
    detailWidth: 55,
  };
  for (const current of [
    { ...rendered, cursor: '22' },
    { ...rendered, filters: { ...rendered.filters!, metadataQuery: 'different' } },
    { ...rendered, descriptor: { ...rendered.descriptor!, upperCursor: '24' } },
  ]) {
    const merged = mergeTrajectoryPresentation(current, rendered, update);
    expect(merged).toEqual({ ...current, detailWidth: 55 });
  }
  const foreign = { ...rendered, descriptor: { ...rendered.descriptor!, sessionId: 'foreign' } };
  expect(mergeTrajectoryPresentation(foreign, rendered, update)).toBe(foreign);
});
