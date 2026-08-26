import { describe, expect, test } from 'bun:test';
import type { KiteAppControlClient } from '@kite-ai/kite-app-contract';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type { RuntimeAccess } from '@kite-ai/runtime-contract';
import type { RuntimeServer } from '@kite-ai/runtime-server';
import {
  createKiteRuntimeApplication,
  type KiteRuntimeApplicationDependencies,
} from '../../src/runtime-application/application';

describe('KiteRuntimeApplication', () => {
  test('keeps lifecycle ownership injected and exposes the quiesce gate', async () => {
    const calls: string[] = [];
    const dependencies: KiteRuntimeApplicationDependencies = {
      runtime: {} as RuntimeAccess,
      server: {} as RuntimeServer,
      history: {} as RuntimeHistoryClient,
      appControl: {} as KiteAppControlClient,
      start: async () => {
        calls.push('start');
      },
      cancelAll: async (reason) => {
        calls.push(`cancel:${reason}`);
      },
      dispose: async () => {
        calls.push('dispose');
      },
    };
    const application = createKiteRuntimeApplication(dependencies);

    await Promise.all([application.start(), application.start()]);
    expect(calls).toEqual(['start']);
    await application.cancelAll('test shutdown');
    expect(calls).toContain('cancel:test shutdown');

    await application[Symbol.asyncDispose]();
    await application[Symbol.asyncDispose]();
    expect(calls.filter((call) => call === 'dispose')).toHaveLength(1);
    await expect(application.start()).rejects.toThrow('disposed');
  });

  test('waits for a concurrent start before disposing and rejects cancellation afterward', async () => {
    const calls: string[] = [];
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    const application = createKiteRuntimeApplication({
      runtime: {} as RuntimeAccess,
      server: {} as RuntimeServer,
      history: {} as RuntimeHistoryClient,
      appControl: {} as KiteAppControlClient,
      start: async () => {
        calls.push('start');
        startEntered();
        await startGate;
      },
      cancelAll: async (reason) => {
        calls.push(`cancel:${reason}`);
      },
      dispose: async () => {
        calls.push('dispose');
      },
    });

    const starting = application.start();
    await entered;
    const disposing = application[Symbol.asyncDispose]();
    expect(calls).toEqual(['start']);
    releaseStart();
    await starting;
    await disposing;
    expect(calls).toEqual(['start', 'dispose']);
    await expect(application.cancelAll('after dispose')).rejects.toThrow('disposed');
  });
});
