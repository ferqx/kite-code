import { describe, expect, test } from 'bun:test';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import {
  HistoryMessageBuilder,
  type Message,
  projectEventWithIdentity,
  projectHistoricalEvent,
} from '../src/presentation';

type FailedRun = Extract<RuntimeClientEvent, { type: 'run.terminal' }>;
const authFailure: FailedRun = {
  type: 'run.terminal',
  runId: 'durable-run',
  status: 'failed',
  outcome: {
    status: 'blocked',
    reasonCode: 'provider_auth_required',
    safeRetry: false,
    recoveryEntry: 'operator_action',
  },
};
const turnFailure: RuntimeClientEvent = {
  type: 'turn.terminal',
  turnId: 'turn-1',
  status: 'failed',
};
const identity = { turnId: 'turn-1' };

function failure(messages: readonly Message[]): Message {
  const notices = messages.filter((message) => message.systemKind === 'turn_failure');
  expect(notices).toHaveLength(1);
  return notices[0]!;
}

function replay(events: readonly RuntimeClientEvent[]): readonly Message[] {
  return events.reduce<readonly Message[]>(
    (messages, event) => projectEventWithIdentity(messages, event, identity),
    [],
  );
}

describe('reply failure presentation', () => {
  test.each([
    'turn-first',
    'run-first',
  ] as const)('merges %s terminal order and duplicates into one classified system row', (order) => {
    const events = order === 'turn-first' ? [turnFailure, authFailure] : [authFailure, turnFailure];
    const messages = replay([...events, ...events]);
    expect(failure(messages)).toMatchObject({
      id: 'failure:turn-1',
      turnId: 'turn-1',
      role: 'system',
      title: '回复失败',
      status: 'failed',
      settled: true,
      failure: {
        summary: '模型服务认证失败',
        reasonCode: 'provider_auth_required',
        outcome: { status: 'blocked', safeRetry: false, recoveryEntry: 'operator_action' },
      },
    });
    expect(failure(messages).text).toContain('凭据');
    expect(messages.filter((message) => message.systemKind === 'turn_terminal')).toHaveLength(1);
    expect(replay(events)).toEqual(messages);
  });

  test('updates richer detail and outcome for the same reason without adding a row', () => {
    const original = replay([authFailure]);
    const enriched: FailedRun = {
      ...authFailure,
      summary: '账号权限尚未恢复。\n请检查当前提供商的凭据。',
      outcome: {
        status: 'unknown',
        reasonCode: 'provider_auth_required',
        safeRetry: true,
        recoveryEntry: 'retry',
      },
    };
    const updated = projectEventWithIdentity(original, enriched, identity);
    expect(failure(updated).text).toBe(enriched.summary!);
    expect(failure(updated).failure).toEqual({
      summary: '模型服务认证失败',
      reasonCode: 'provider_auth_required',
      outcome: { status: 'unknown', safeRetry: true, recoveryEntry: 'retry' },
    });
    expect(projectEventWithIdentity(updated, enriched, identity)).toEqual(updated);
  });

  test('a later same-reason event without summary and a generic turn terminal retain full detail', () => {
    const summary = '检查账号访问权限后再发送。\n这是安全的分类说明。';
    const enriched = { ...authFailure, summary };
    const withDetail = replay([enriched]);
    const withoutSummary = projectEventWithIdentity(withDetail, authFailure, identity);
    expect(failure(withoutSummary).text).toBe(summary);
    expect(failure(withoutSummary).failure).toEqual(failure(withDetail).failure);
    const lateTurn = projectEventWithIdentity(
      withoutSummary,
      { ...turnFailure, summary: '本轮回复未完成' },
      identity,
    );
    expect(failure(lateTurn).text).toBe(summary);
    expect(failure(lateTurn).failure).toEqual(failure(withDetail).failure);
  });

  test('a different unknown reason does not reuse the old authentication explanation', () => {
    const old = replay([{ ...authFailure, summary: '账号认证说明。' }]);
    const changed: FailedRun = {
      ...authFailure,
      outcome: {
        status: 'unknown',
        reasonCode: 'unrecognized_runtime_failure',
        safeRetry: false,
        recoveryEntry: 'reconcile',
      },
    };
    const messages = projectEventWithIdentity(old, changed, identity);
    expect(failure(messages).failure).toEqual({
      summary: '本轮回复未完成',
      reasonCode: 'unrecognized_runtime_failure',
      outcome: { status: 'unknown', safeRetry: false, recoveryEntry: 'reconcile' },
    });
    expect(failure(messages).text).not.toContain('认证');
    expect(failure(messages).text).not.toContain('模型服务');
    const detailed = projectEventWithIdentity(
      messages,
      { ...changed, summary: '需要核对执行状态。\n不要重复派发。' },
      identity,
    );
    expect(failure(detailed).failure?.summary).toBe('需要核对执行状态。');
    expect(failure(detailed).text).toBe('需要核对执行状态。\n不要重复派发。');
  });

  test('the supplied Turn identity wins over a persistent Run id without settling another turn', () => {
    const current: Message = {
      id: 'thinking-current',
      turnId: 'turn-current',
      role: 'thinking',
      text: '当前轮仍在处理',
      settled: false,
      status: 'running',
    };
    const messages = projectEventWithIdentity([current], authFailure, identity);
    expect(messages[0]).toBe(current);
    expect(failure(messages)).toMatchObject({ id: 'failure:turn-1', turnId: 'turn-1' });
    expect(messages.some((message) => message.id === 'failure:durable-run')).toBe(false);
    const terminal = projectEventWithIdentity(messages, turnFailure);
    expect(failure(terminal).id).toBe('failure:turn-1');
    expect(terminal[0]).toBe(current);
  });

  test('historical indexed replay matches immutable realtime enrichment and deduplication', () => {
    const events: RuntimeClientEvent[] = [
      turnFailure,
      authFailure,
      { ...authFailure, summary: '安全失败详情。\n需要检查账号权限。' },
      authFailure,
      { ...turnFailure, summary: '通用失败说明' },
      {
        ...authFailure,
        outcome: {
          status: 'unknown',
          reasonCode: 'unrecognized_runtime_failure',
          safeRetry: false,
          recoveryEntry: 'reconcile',
        },
      },
    ];
    const builder = new HistoryMessageBuilder();
    let realtime: readonly Message[] = [];
    for (const event of events) {
      realtime = projectEventWithIdentity(realtime, event, identity);
      projectHistoricalEvent(builder, event, identity);
      expect(builder.messages).toEqual([...realtime]);
    }
    expect(failure(builder.messages).failure?.reasonCode).toBe('unrecognized_runtime_failure');
  });
});
