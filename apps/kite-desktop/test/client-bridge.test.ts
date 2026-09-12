import { expect, test } from 'bun:test';
import { DesktopClient } from '../src/client';
import { createTestDesktopBridge, type DesktopTestCall } from './desktop-bridge';

test('desktop client leaves native drag to CSS and only toggles maximize on a double click', async () => {
  const calls: string[] = [];
  const call: DesktopTestCall = async <T>(command: string) => {
    calls.push(command);
    return undefined as T;
  };
  const client = new DesktopClient(createTestDesktopBridge(call));

  await client.handleHeaderMouseDown(1);
  expect(calls).toEqual([]);
  await client.handleHeaderMouseDown(2);
  expect(calls).toEqual(['animated_toggle_maximize']);
});

test('desktop client sends the existing project-switch confirmation through the named bridge', async () => {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const call: DesktopTestCall = async <T>(command: string, args?: Record<string, unknown>) => {
    expect(command).toBe('show_confirm');
    seen.push(args);
    return true as T;
  };
  const client = new DesktopClient(createTestDesktopBridge(call));

  await expect(
    client.confirm({
      message: '切换执行项目将停止当前服务中的任务，已有修改不会撤销。',
      title: '切换执行项目？',
      kind: 'warning',
      okLabel: '停止并继续',
      cancelLabel: '保留当前任务',
    }),
  ).resolves.toBe(true);
  expect(seen).toEqual([
    {
      message: '切换执行项目将停止当前服务中的任务，已有修改不会撤销。',
      title: '切换执行项目？',
      kind: 'warning',
      okLabel: '停止并继续',
      cancelLabel: '保留当前任务',
    },
  ]);
});
