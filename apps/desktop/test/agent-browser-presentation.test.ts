import { expect, test } from 'bun:test';
import type { Execution } from '@kite-ai/client';
import {
  AgentBrowserPresentation,
  agentBrowserPresentationKeys,
} from '../src/agent-browser-presentation';
import type { NativeSelection } from '../src/native-bridge';

const job = {
  id: 'browser-job',
  originStoreId: 'store',
  sessionId: 'session',
  kind: 'job',
  definitionId: 'browser.session',
  definitionVersion: '1',
  status: 'running',
  cancelRequestedAt: null,
} as Execution;
const selection = (executions = [job]) =>
  ({
    canReadExtensions: true,
    storeId: 'store',
    session: { id: 'session', parentSessionId: null },
    executions,
  }) as unknown as NativeSelection;
test('only current verified browser Job presents the sidebar, not foreign/session background or pending work', () => {
  expect(agentBrowserPresentationKeys(selection(), 'session')).toHaveLength(1);
  expect(agentBrowserPresentationKeys(selection(), 'other')).toEqual([]);
  expect(
    agentBrowserPresentationKeys(selection([{ ...job, originStoreId: 'foreign' }]), 'session'),
  ).toEqual([]);
  expect(
    agentBrowserPresentationKeys(selection([{ ...job, sessionId: 'other' }]), 'session'),
  ).toEqual([]);
  expect(
    agentBrowserPresentationKeys(selection([{ ...job, status: 'planned' }]), 'session'),
  ).toEqual([]);
  expect(agentBrowserPresentationKeys({ ...selection(), viewLoading: true }, 'session')).toEqual(
    [],
  );
  expect(
    agentBrowserPresentationKeys(
      selection([{ ...job, definitionId: 'browser.open', kind: 'tool' }]),
      'session',
    ),
  ).toEqual([]);
});
test('dismissed browser identity stays dismissed across polling and session returns; a new owned Job may present', () => {
  const owner = new AgentBrowserPresentation(),
    keys = agentBrowserPresentationKeys(selection(), 'session');
  expect(owner.observe(keys)).toBe(true);
  expect(owner.observe(keys)).toBe(false);
  expect(owner.observe([])).toBe(false);
  expect(owner.observe(keys)).toBe(false);
  expect(
    owner.observe(
      agentBrowserPresentationKeys(selection([{ ...job, id: 'new-browser' }]), 'session'),
    ),
  ).toBe(true);
});
