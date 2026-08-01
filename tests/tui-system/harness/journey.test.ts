import { describe, expect, test } from 'bun:test';
import { createTuiSystemJourney } from './journey';

describe('TUI system journey', () => {
  test('runs registered steps in order inside one test boundary', async () => {
    const calls: string[] = [];
    const journey = createTuiSystemJourney();
    journey.step('start', () => {
      calls.push('start');
    });
    journey.step('continue', async () => {
      await Promise.resolve();
      calls.push('continue');
    });

    await journey.run();

    expect(calls).toEqual(['start', 'continue']);
    expect(journey.size()).toBe(2);
  });

  test('reports the failing checkpoint and does not run dependent steps', async () => {
    const calls: string[] = [];
    const journey = createTuiSystemJourney();
    journey.step('broken action', () => {
      calls.push('broken');
      throw new Error('underlying failure');
    });
    journey.step('dependent assertion', () => {
      calls.push('dependent');
    });

    await expect(journey.run()).rejects.toThrow(
      'TUI system journey failed at step 1/2: broken action',
    );
    expect(calls).toEqual(['broken']);
  });

  test('keeps a bounded timeout for each checkpoint', async () => {
    const journey = createTuiSystemJourney();
    let settled = false;
    journey.step(
      'never settles',
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            settled = true;
            reject(signal.reason);
          });
        }),
      10,
    );

    await expect(journey.run()).rejects.toThrow(
      'TUI system journey failed at step 1/1: never settles',
    );
    expect(settled).toBe(true);
  });

  test('reports the active step before the outer Bun and file deadlines', async () => {
    const journey = createTuiSystemJourney();
    journey.step(
      'active at journey deadline',
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
      1_000,
    );

    try {
      await journey.run(10);
      throw new Error('expected journey deadline to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('active at journey deadline');
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toContain('journey deadline of 10ms');
    }
  });

  test('bounds cancellation settlement when a step ignores its AbortSignal', async () => {
    const journey = createTuiSystemJourney();
    journey.step('ignores cancellation', () => new Promise(() => {}), 10);
    const startedAt = Date.now();

    await expect(journey.run()).rejects.toThrow(
      'TUI system journey failed at step 1/1: ignores cancellation',
    );

    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
