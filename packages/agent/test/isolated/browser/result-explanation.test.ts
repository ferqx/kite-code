import { expect, test } from 'bun:test';
import type { Json, ToolResult } from '../../../src/extensions';
import { explainBrowserExecutionResult } from '../../../src/tools/browser/result-explanation';

test('an already bound page is distinguished from a missing retained page without changing dispatch facts', () => {
  const operations = [{ definitionId: 'browser.snapshot', outcome: 'succeeded' }];
  const input: ToolResult = {
    outcome: 'failed',
    content: 'browser_page_already_open',
    details: { operations },
  };
  const result = explainBrowserExecutionResult(input);
  expect(result.outcome).toBe('failed');
  expect(result.details).toMatchObject({ operations });
  expect(result.content).toContain('Another page is already bound in this task');
  expect(result.content).toContain('did not acquire the requested candidate');
  expect(result.content).toContain('does not show that either page closed or disappeared');
  expect(result.content).toContain('give a normal final answer');
  expect(result.content).toContain('A later user message can bind the intended retained page');
  expect(result.content).toContain('Diagnostic code: browser_page_already_open');
  expect(input.content).toBe('browser_page_already_open');
});

for (const code of ['browser_page_recovery_required', 'browser_page_observation_required'])
  test(`${code} requires a new observation without replaying or confirming an old navigation`, () => {
    const input: ToolResult = { outcome: 'failed', content: code, details: { operations: [] } };
    const result = explainBrowserExecutionResult(input);
    expect(result.outcome).toBe('failed');
    expect(result.content).toContain('snapshot');
    expect(result.content).toContain('remains unknown');
    expect(result.content).toContain(`Diagnostic code: ${code}`);
    expect(result.details).toMatchObject({ operations: [] });
    expect(input.content).toBe(code);
  });

for (const outcome of ['failed', 'outcome_unknown'] as const)
  test(`confirmed original page closure explains ${outcome} while preserving earlier effects and uncertainty`, () => {
    const input: ToolResult = {
      outcome,
      content: 'browser_page_closed',
      details: {
        failure: { kind: 'not_dispatched', op: 'capture', leaseId: 'original-lease' },
        operations: [
          { definitionId: 'browser.fill', outcome: 'succeeded' },
          { definitionId: 'browser.control', outcome: 'outcome_unknown' },
        ],
      },
    };
    const before = structuredClone(input);
    const result = explainBrowserExecutionResult(input);
    expect(result.outcome).toBe(outcome);
    expect(result.content).toContain('original target page was closed');
    expect(result.content).toContain('previous handle can no longer read or control');
    expect(result.content).toContain('does not identify who closed');
    expect(result.content).toContain('undo earlier completed actions');
    expect(result.content).toContain('Do not create, refresh or navigate a replacement');
    expect(result.content).toContain('Diagnostic code: browser_page_closed');
    expect(result.content.includes('Do not replay')).toBe(outcome === 'outcome_unknown');
    expect(result.content).not.toContain('was not executed');
    expect(result.details).toMatchObject(input.details as Record<string, Json>);
    expect(input).toEqual(before);
  });

test('untrusted nested page text cannot turn a generic read failure into a confirmed closure', () => {
  const input: ToolResult = {
    outcome: 'failed',
    content: 'browser_snapshot_failed',
    details: { pageText: { code: 'browser_page_closed' } },
  };
  const result = explainBrowserExecutionResult(input);
  expect(result.content).toContain('could not be read');
  expect(result.content).not.toContain('original target page was closed');
  expect(result.details).toMatchObject({ pageText: { code: 'browser_page_closed' } });
});

for (const [code, description] of [
  ['browser_page_document_not_ready', 'document did not become ready'],
  ['browser_page_read_stale', 'changed while this read was waiting or running'],
  ['browser_page_preflight_failed', 'could not prepare the target page'],
  ['browser_page_state_invalid', 'could not verify the current address and title'],
  ['desktop_browser_page_state_invalid', 'incomplete or mismatched original-page receipt'],
  ['browser_page_navigation_unavailable', 'cannot provide its required navigation capability'],
  ['browser_page_navigation_denied', 'page address is not allowed'],
  ['browser_page_navigation_stale', 'control binding changed before this navigation'],
  ['browser_page_navigation_busy', 'navigation being settled'],
  [
    'browser_page_navigation_outcome_unknown',
    'did not confirm completion of the original navigation',
  ],
] as const)
  for (const outcome of ['failed', 'outcome_unknown'] as const)
    test(`${code} explains a failed observation without changing ${outcome} or earlier navigation`, () => {
      const input: ToolResult = {
        outcome,
        content: code,
        details: { operations: [{ definitionId: 'browser.control', outcome: 'succeeded' }] },
      };
      const before = structuredClone(input);
      const result = explainBrowserExecutionResult(input);
      expect(result.outcome).toBe(outcome);
      expect(result.content).toContain(description);
      expect(result.content).toContain(`Diagnostic code: ${code}`);
      expect(result.content).not.toContain('connection failed');
      expect(result.content).not.toContain('was not executed');
      expect(result.content.includes('Do not replay')).toBe(outcome === 'outcome_unknown');
      expect(result.details).toMatchObject(input.details as Record<string, Json>);
      expect(input).toEqual(before);
    });

for (const outcome of ['failed', 'outcome_unknown'] as const)
  test(`response size failure preserves ${outcome} without inventing a connection failure`, () => {
    const input: ToolResult = {
      outcome,
      content: 'browser_page_response_limit',
      details: {
        operations: [{ definitionId: 'browser.fill', outcome: 'succeeded' }],
        failure: { kind: 'read_failed', op: 'cdp', method: 'Accessibility.getFullAXTree' },
      },
    };
    const before = structuredClone(input);
    const result = explainBrowserExecutionResult(input);
    expect(result.outcome).toBe(outcome);
    expect(result.content).toContain('response size limit');
    expect(result.content).toContain('does not establish that the page closed');
    expect(result.content).toContain('Earlier actions keep their recorded outcomes');
    expect(result.content).not.toContain('connection failed');
    expect(result.content).not.toContain('was not executed');
    expect(result.content.includes('Do not replay')).toBe(outcome === 'outcome_unknown');
    expect(result.details).toMatchObject(input.details as Record<string, Json>);
    expect(input).toEqual(before);
  });

for (const outcome of ['failed', 'outcome_unknown'] as const)
  test(`new-page creation ${outcome} is explained without inferring capacity or partial-allocation results`, () => {
    const input: ToolResult = {
      outcome,
      content: 'browser_page_grant_create_failed',
      details: { operations: [] },
    };
    const before = structuredClone(input);
    const result = explainBrowserExecutionResult(input);
    expect(result.outcome).toBe(outcome);
    expect(result.content).toContain('could not prepare the requested new tab');
    expect(result.content).toContain('whether a partial page was created are not confirmed');
    expect(result.content).toContain('does not authorize overwriting');
    expect(result.content).not.toContain('capacity');
    expect(result.content).toContain('Diagnostic code: browser_page_grant_create_failed');
    if (outcome === 'outcome_unknown') expect(result.content).toContain('Do not replay');
    expect(input).toEqual(before);
  });

for (const code of ['browser_page_capacity', 'browser_tab_limit'])
  test(`${code} explains the limit without allowing an existing page to be replaced`, () => {
    const input: ToolResult = {
      outcome: 'failed',
      content: code,
      details: { code, dispatchCommitted: false, adapterAttempted: false },
    };
    const before = structuredClone(input);
    const result = explainBrowserExecutionResult(input);
    expect(result.outcome).toBe('failed');
    expect(result.content).toContain('limit');
    expect(result.content).toContain('preserving the existing pages');
    expect(result.content).toContain('do not silently reuse or navigate a different page');
    expect(result.content).toContain(`Diagnostic code: ${code}`);
    expect(result.details).toMatchObject({
      code,
      dispatchCommitted: false,
      adapterAttempted: false,
    });
    expect(input).toEqual(before);
  });

function wrappedBrowserStop(): ToolResult {
  const actualResult = {
    content:
      'browser_stop_unconfirmed. The original action must not be retried; inspect this browser or close it.',
    details: { code: 'browser_stop_unconfirmed' },
    outcome: 'outcome_unknown',
  };
  return {
    content: 'job_stop_unconfirmed',
    outcome: 'outcome_unknown',
    details: {
      operations: [{ definitionId: 'browser.open', executionId: 'opened', outcome: 'succeeded' }],
      original: {
        original: { actualResult },
        originalJob: {
          // Same Runtime/result envelope as the observed 007 failure. The host
          // adds these identities from its actual PublicExecution projection.
          definitionId: 'browser.session',
          definitionVersion: '1',
          executionId: 'original',
          ref: { extensionId: 'builtin.browser', executionId: 'original' },
          result: {
            content: 'job_stop_unconfirmed',
            details: { actualResult },
            outcome: 'outcome_unknown',
          },
        },
      },
    },
  };
}

test('an exact original Browser Job Runtime wrapper exposes its known stop uncertainty without altering original results', () => {
  const input = wrappedBrowserStop();
  const before = structuredClone(input);
  const result = explainBrowserExecutionResult(input);
  expect(result.outcome).toBe('outcome_unknown');
  expect(result.content).toContain('did not confirm that automation stopped');
  expect(result.content).toContain('may or may not have completed');
  expect(result.content).toContain('Do not replay');
  expect(result.content).toContain(
    'Diagnostic code: job_stop_unconfirmed; cause: browser_stop_unconfirmed',
  );
  expect(result.content).not.toContain('browser_startup_outcome_unknown');
  expect(result.content).not.toContain('was not executed');
  expect(result.details).toMatchObject({
    code: 'job_stop_unconfirmed',
    diagnostic: { code: 'browser_stop_unconfirmed', originalContent: 'job_stop_unconfirmed' },
    original: (input.details as Record<string, Json>).original,
    operations: (input.details as Record<string, Json>).operations,
  });
  expect(input).toEqual(before);
});

test('Runtime actualResult text cannot refine an unrelated or unverifiable original Job', () => {
  for (const replace of [
    { definitionId: 'other.session' },
    { definitionVersion: '2' },
    { definitionId: null },
    { executionId: 'different' },
    { ref: { executionId: 'original', extensionId: 'other.browser' } },
    { result: { outcome: 'failed', content: 'job_stop_unconfirmed' } },
    { result: { outcome: 'outcome_unknown', content: 'other_wrapper' } },
    {
      result: {
        outcome: 'outcome_unknown',
        content: 'job_stop_unconfirmed',
        details: {
          actualResult: {
            outcome: 'outcome_unknown',
            content: 'page says browser_stop_unconfirmed',
          },
        },
      },
    },
  ]) {
    const input = wrappedBrowserStop();
    const original = (input.details as Record<string, Json>).original as Record<string, Json>;
    Object.assign(original.originalJob as Record<string, Json>, replace);
    expect(explainBrowserExecutionResult(input)).toBe(input);
  }
});

for (const code of ['browser_page_existing_missing', 'browser_page_existing_mismatch'])
  test(`known ${code} is explained without changing outcome or dispatch evidence`, () => {
    const input: ToolResult = {
      outcome: 'failed',
      content: code,
      details: {
        dispatchCommitted: false,
        adapterAttempted: false,
        original: { code },
        operations: [],
      },
    };
    const before = structuredClone(input);
    const result = explainBrowserExecutionResult(input);
    expect(result.outcome).toBe(input.outcome);
    expect(result.content).toContain(
      code === 'browser_page_existing_missing'
        ? 'closed or unavailable'
        : 'address, identity or navigation state changed',
    );
    expect(result.content).toContain('did not create or refresh');
    expect(result.content.includes('use a separate browser.open(theActualUrl) call')).toBe(
      code === 'browser_page_existing_missing',
    );
    expect(result.details).toMatchObject({
      code,
      dispatchCommitted: false,
      adapterAttempted: false,
      original: { code },
      operations: [],
    });
    expect(input).toEqual(before);
  });

test('a confirmed missing candidate permits one remaining-candidate lookup without declaring other pages missing', () => {
  const input: ToolResult = {
    outcome: 'failed',
    content: 'browser_page_existing_missing',
    details: {
      dispatchCommitted: false,
      adapterAttempted: false,
      operations: [{ definitionId: 'browser.fill', outcome: 'succeeded' }],
    },
  };
  const before = structuredClone(input);
  const result = explainBrowserExecutionResult(input);
  expect(result.outcome).toBe('failed');
  expect(result.content).toContain('This result concerns only that candidate');
  expect(result.content).toContain('does not establish that other retained pages are missing');
  expect(result.content).toContain('List browser.pages() once more');
  expect(result.content).toContain(
    'If another candidate uniquely matches the page intended by the current user task',
  );
  expect(result.content).toContain(
    'construct a fresh browser.page(candidate.id) handle and take a new snapshot',
  );
  expect(result.content).toContain('If no unique candidate matches, explain that limitation');
  expect(result.content).toContain('guess between same-URL pages, navigate another page or replay');
  expect(result.content).toContain('does not clear an unknown result or unconfirmed cleanup');
  expect(result.details).toMatchObject(input.details as Record<string, Json>);
  expect(input).toEqual(before);
});

for (const code of [
  'browser_existing_page_unavailable',
  'browser_snapshot_failed',
  'browser_page_existing_mismatch',
  'browser_previous_cleanup_unconfirmed',
  'browser_startup_outcome_unknown',
])
  test(`${code} never turns connection loss or uncertainty into new-page recovery`, () => {
    const input: ToolResult = { outcome: 'failed', content: code };
    const result = explainBrowserExecutionResult(input);
    expect(result.content).not.toContain('use a separate browser.open(theActualUrl) call');
    expect(result.content).not.toContain('List browser.pages() once more');
    expect(input.content).toBe(code);
  });

test('an unknown missing-page result cannot authorize a new opening', () => {
  const input: ToolResult = {
    outcome: 'outcome_unknown',
    content: 'browser_page_existing_missing',
  };
  const result = explainBrowserExecutionResult(input);
  expect(result.content).not.toContain('use a separate browser.open(theActualUrl) call');
  expect(result.content).not.toContain('List browser.pages() once more');
  expect(result.content).toContain('Do not replay it');
  expect(result.outcome).toBe('outcome_unknown');
});

test('a failed wrapper with an original unknown outcome cannot advise binding another candidate', () => {
  const input: ToolResult = {
    outcome: 'failed',
    content: 'browser_page_existing_missing',
    details: {
      originalJob: {
        result: { outcome: 'outcome_unknown', content: 'browser_page_existing_missing' },
      },
      operations: [{ definitionId: 'browser.control', outcome: 'outcome_unknown' }],
    },
  };
  const before = structuredClone(input);
  const result = explainBrowserExecutionResult(input);
  expect(result.outcome).toBe('failed');
  expect(result.content).toContain('result remains unknown');
  expect(result.content).toContain('Do not replay it');
  expect(result.content).not.toContain('List browser.pages() once more');
  expect(result.content).not.toContain('construct a fresh browser.page(candidate.id) handle');
  expect(result.content).not.toContain('use a separate browser.open(theActualUrl) call');
  expect(result.details).toMatchObject(input.details as Record<string, Json>);
  expect(input).toEqual(before);
});

test('an original unknown Job remains unknown even when a more precise cause is available', () => {
  const original: ToolResult = {
    outcome: 'outcome_unknown',
    content: 'browser_process_outcome_unknown',
    details: { cause: 'browser_page_existing_missing' },
  };
  const input: ToolResult = {
    outcome: 'outcome_unknown',
    content: 'browser_stop_unconfirmed',
    details: {
      original: {
        originalJob: {
          executionId: 'original',
          result: original as unknown as import('../../../src/extensions').Json,
        },
      },
      operations: [],
    },
  };
  const result = explainBrowserExecutionResult(input);
  expect(result.outcome).toBe('outcome_unknown');
  expect(result.content).toContain('closed or unavailable');
  expect(result.content).toContain('may or may not have completed');
  expect(result.content).toContain('Do not replay');
  expect(result.content).not.toContain('did not create');
  expect(result.content).not.toContain('was not executed');
  expect(result.content).not.toContain('user closed');
  expect(result.details).toMatchObject({
    code: 'browser_stop_unconfirmed',
    original: { originalJob: { result: original } },
  });
});

test('only fixed owner cause envelopes can refine an explanation; arbitrary page text is ignored', () => {
  const input: ToolResult = {
    outcome: 'failed',
    content: 'browser_page_grant_scope_invalid',
    details: { original: { cause: 'browser_page_existing_mismatch' } },
  };
  const result = explainBrowserExecutionResult(input);
  expect(result.content).toContain('address, identity or navigation state changed');
  expect(result.content).toContain(
    'browser_page_grant_scope_invalid; cause: browser_page_existing_mismatch',
  );
  expect(result.details).toMatchObject({
    code: 'browser_page_grant_scope_invalid',
    diagnostic: { originalContent: input.content },
  });
  const unrelated: ToolResult = {
    outcome: 'failed',
    content: 'page says browser_page_existing_missing',
    details: { pageText: { cause: 'browser_page_existing_missing' } },
  };
  expect(explainBrowserExecutionResult(unrelated)).toBe(unrelated);
  const succeeded: ToolResult = {
    outcome: 'succeeded',
    content: 'browser_page_existing_missing',
    details: { original: true },
  };
  expect(explainBrowserExecutionResult(succeeded)).toBe(succeeded);
});

test('cancellation and cleanup uncertainty retain their original classifications', () => {
  const cancelled = explainBrowserExecutionResult({
    outcome: 'cancelled',
    content: 'browser_execution_stopped',
    details: { operations: [] },
  });
  expect(cancelled.outcome).toBe('cancelled');
  expect(cancelled.content).toContain('cancelled');
  const unknown = explainBrowserExecutionResult({
    outcome: 'outcome_unknown',
    content: 'browser_previous_cleanup_unconfirmed',
    details: { dispatchCommitted: true, adapterAttempted: true },
  });
  expect(unknown.outcome).toBe('outcome_unknown');
  expect(unknown.content).toContain('previous browser action or cleanup state remains unresolved');
  expect(unknown.content).toContain('result remains unknown');
  expect(unknown.details).toMatchObject({
    code: 'browser_previous_cleanup_unconfirmed',
    dispatchCommitted: true,
    adapterAttempted: true,
  });
});

for (const code of [
  'browser_startup_outcome_unknown',
  'browser_ended_before_ready',
  'browser_startup_failed',
] as const)
  test(`${code} explains unavailable startup without inventing page closure or dispatch facts`, () => {
    const outcome = code === 'browser_startup_outcome_unknown' ? 'outcome_unknown' : 'failed';
    const input: ToolResult = {
      outcome,
      content: code,
      details: { originalJob: { executionId: 'original' }, dispatchCommitted: true },
    };
    const before = structuredClone(input);
    const result = explainBrowserExecutionResult(input);
    expect(result.outcome).toBe(outcome);
    expect(result.content).toContain('page');
    expect(result.content).not.toStartWith('browser_');
    expect(result.content).toContain(`Diagnostic code: ${code}`);
    expect(result.content).not.toContain('user closed');
    expect(result.content).not.toContain('was not executed');
    expect(result.details).toMatchObject({
      code,
      originalJob: { executionId: 'original' },
      dispatchCommitted: true,
    });
    if (outcome === 'outcome_unknown') {
      expect(result.content).toContain('binding the target page or starting its navigation');
      expect(result.content).toContain('may have closed');
      expect(result.content).toContain('may or may not have completed');
      expect(result.content).toContain('Do not replay');
    }
    expect(input).toEqual(before);
  });

for (const code of [
  'browser_page_dialog_cleanup_unknown',
  'browser_page_dialog_outcome_unknown',
] as const)
  test(`${code} preserves a possibly completed dialog decision without authorizing stale-reference replay`, () => {
    const input: ToolResult = {
      outcome: 'outcome_unknown',
      content: 'browser_page_dialog_outcome_unknown',
      details: {
        cause: code,
        dispatchCommitted: true,
        adapterAttempted: true,
      },
    };
    const before = structuredClone(input);
    const result = explainBrowserExecutionResult(input);
    expect(result.outcome).toBe('outcome_unknown');
    expect(result.content).toContain('page may already have received');
    expect(result.content).toContain('native dialog interface');
    expect(result.content).toContain('Do not use the old dialog reference');
    expect(result.content).toContain('may or may not have completed');
    expect(result.content).toContain('Do not replay');
    expect(result.content).toContain(`Diagnostic code: browser_page_dialog_outcome_unknown`);
    expect(result.content).not.toContain('was not executed');
    expect(result.details).toMatchObject({
      code: 'browser_page_dialog_outcome_unknown',
      cause: code,
      dispatchCommitted: true,
      adapterAttempted: true,
      diagnostic: { code },
    });
    expect(input).toEqual(before);
  });
