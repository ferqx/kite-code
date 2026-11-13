import { expect, test } from '#kite-test';
import {
  mcpTaskStatusContent,
  mcpToolResultContent,
  mcpUnconfirmedContent,
} from '../../../src/mcp/result-feedback';

test('remote failure data keeps original text and structured business fields without filtering internal-looking names', () => {
  const remote = {
    isError: true,
    content: [{ type: 'text', text: '远端原文: Job failed; Session metadata remains.' }],
    structuredContent: {
      job: 'customer-order',
      carrier: 'shipping-vendor',
      metadata: { dispatch: 'business-value', original: '原值' },
    },
  };
  const original = structuredClone(remote);
  const content = mcpToolResultContent(remote);
  expect(JSON.parse(content.split('\n').at(-1)!)).toEqual(remote);
  expect(content).toContain('remote call was attempted');
  expect(content).toContain('does not prove earlier effects were rolled back');
  expect(content).not.toContain('Diagnostic code:');
  expect(remote).toEqual(original);
});

test('unconfirmed responses retain uncertainty and forbid replay without adding internal diagnostic prose', () => {
  for (const code of [
    'mcp_output_invalid',
    'mcp_task_output_invalid',
    'mcp_task_input_required_unsupported',
    'mcp_call_unconfirmed',
  ]) {
    const content = mcpUnconfirmedContent(code);
    expect(content).toContain('may still be running or have effects');
    expect(content).toContain('Do not repeat the operation');
    expect(content).toContain('does not prove it stopped or rolled back');
    expect(content).not.toContain(code);
    expect(content).not.toMatch(/\b(?:Job|carrier|Run|Session|dispatch)\b/i);
  }
});

test('remote terminal status preserves original task handle and status text without claiming rollback', () => {
  const task = {
    taskId: 'original-remote-handle',
    status: 'cancelled' as const,
    statusMessage: '用户远端原文: Job cancelled; partial order remains.',
  };
  const content = mcpTaskStatusContent(task);
  expect(JSON.parse(content.split('\n').at(-1)!)).toEqual(task);
  expect(content).toContain('does not prove earlier effects were rolled back');
  expect(content).not.toContain('Diagnostic code:');
});
