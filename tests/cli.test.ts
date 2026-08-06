import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../src/app/cli/index';

// 测试 CLI 命令行参数解析逻辑 / Test CLI argument parsing logic
describe('cli argument parsing', () => {
  // 验证 run 命令默认使用新线程，避免恢复过期的中断 / Verify run defaults to fresh thread to avoid stale interrupt resume
  test('run uses a fresh thread by default to avoid resuming stale interrupts', () => {
    const args = parseArgs(['run', '--task', '你当前是什么模型？上下文有多长']);

    expect(args.task).toBe('你当前是什么模型？上下文有多长');
    expect(args.threadId).toStartWith('run-'); // 自动生成的线程 ID 以 run- 开头 / Auto-generated thread ID starts with run-
    expect(args.threadId).not.toBe('default-thread'); // 不使用 default-thread 避免冲突 / Not using default-thread to avoid collision
  });

  // 验证 --task 被 npm 消费后，run 命令能通过位置参数接收任务文本 / Verify run accepts task as positional argument after npm strips --task
  test('run accepts the task as positional text after npm consumes --task', () => {
    const args = parseArgs(['run', '你当前是什么模型？上下文有多长']);

    expect(args.task).toBe('你当前是什么模型？上下文有多长');
  });

  // 验证用户显式指定线程时，run 命令保留该线程 ID / Verify run keeps explicit thread ID for conversation continuity
  test('run keeps an explicit thread when the user wants conversation continuity', () => {
    const args = parseArgs(['run', '--thread', 'conversation-a', '--task', 'hello']);

    expect(args.threadId).toBe('conversation-a');
  });

  // 验证 resume 命令在未提供线程时默认使用 default-thread / Verify resume defaults to default-thread when no thread given
  test('resume still targets the default thread when no thread is provided', () => {
    const args = parseArgs(['resume', '--approve']);

    expect(args.threadId).toBe('default-thread');
  });

  // 验证 resume 支持用户输入回答，用于恢复 ask_user 中断 / Verify resume accepts user answers for ask_user interrupts
  test('resume accepts a user answer for clarification interrupts', () => {
    const args = parseArgs(['resume', '--thread', 'conversation-a', '--answer', '使用最小实现']);

    expect(args.threadId).toBe('conversation-a');
    expect(args.answer).toBe('使用最小实现');
    expect(args.approve).toBe(false);
  });

  // 验证工具审批恢复可以携带审批 hash 和替换命令 / Tool approval resume accepts approval hash and replacement command
  test('resume accepts approval hash and replacement command', () => {
    const args = parseArgs([
      'resume',
      '--thread',
      'conversation-a',
      '--approve',
      '--approval-hash',
      'hash-a',
      '--replace-command',
      'bun test tests/graph.test.ts',
    ]);

    expect(args.approvalHash).toBe('hash-a');
    expect(args.replacementCommand).toBe('bun test tests/graph.test.ts');
    expect(args.approvalGrant).toBe('approve_once');
  });

  // 验证 resume 支持同命令授权 / Verify resume accepts same-command approval grants
  test('resume accepts approve-same-command grant', () => {
    const args = parseArgs([
      'resume',
      '--thread',
      'conversation-a',
      '--approve-same-command',
      '--approval-hash',
      'hash-a',
    ]);

    expect(args.approve).toBe(true);
    expect(args.approvalGrant).toBe('same_command');
    expect(args.approvalHash).toBe('hash-a');
  });

  // 验证 resume 支持当前 thread 的 full_access 授权 / Verify resume accepts full-access grants
  test('resume accepts full-access grant', () => {
    const args = parseArgs([
      'resume',
      '--thread',
      'conversation-a',
      '--full-access',
      '--approval-hash',
      'hash-a',
    ]);

    expect(args.approve).toBe(true);
    expect(args.approvalGrant).toBe('full_access');
    expect(args.approvalHash).toBe('hash-a');
  });

  test('rejects declared flags outside their command grammar before parsing values', () => {
    expect(() => parseArgs(['run', '--approve'])).toThrow(
      'Option --approve is not available for command run.',
    );
    expect(() => parseArgs(['run', '--turn', '1'])).toThrow(
      'Option --turn is not available for command run.',
    );
    expect(() => parseArgs(['trace', '--task', 'ignored'])).toThrow(
      'Option --task is not available for command trace.',
    );
    expect(() => parseArgs(['trace', '--full-access'])).toThrow(
      'Option --full-access is not available for command trace.',
    );
  });

  // 验证 run 命令的 --mode 参数（read-only/plan 已移除，退回 auto）/ Verify run --mode accepts write/builder, others default to auto
  test('run accepts explicit workspace access mode values', () => {
    const args = parseArgs(['run', '--mode', 'read-only', '--task', 'Create hello.txt']);
    const planArgs = parseArgs(['run', '--mode', 'plan', '--task', 'Create hello.txt']);
    const writeArgs = parseArgs(['run', '--mode', 'write', '--task', 'Create hello.txt']);

    expect(args.mode).toBe('auto');
    expect(planArgs.mode).toBe('auto');
    expect(writeArgs.mode).toBe('write');
  });

  // 验证 --skill 参数解析为单值 / Verify --skill flag is parsed
  test('parses --skill flag', () => {
    const result = parseArgs(['run', '--task', 'fix', '--skill', 'tdd']);
    expect(result.skills).toContain('tdd');
  });

  // 验证多个 --skill 参数解析为数组，保持顺序 / Verify multiple --skill flags parse as ordered array
  test('parses multiple --skill flags', () => {
    const result = parseArgs(['run', '--task', 'fix', '--skill', 'tdd', '--skill', 'debugging']);
    expect(result.skills).toEqual(['tdd', 'debugging']);
  });

  // 验证未提供 --skill 时 skills 字段默认为空数组 / Verify skills defaults to empty array when not provided
  test('defaults skills to empty array', () => {
    const result = parseArgs(['run', '--task', 'fix']);
    expect(result.skills).toEqual([]);
  });
});
