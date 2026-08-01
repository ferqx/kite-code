import { describe, expect, test } from 'bun:test';
import {
  hasSustainedPositiveSlope,
  resourceTrendFailures,
} from './tui-system/harness/resource-trend';

describe('TUI system resource trend gate', () => {
  test('rejects a sustained material increase', () => {
    expect(hasSustainedPositiveSlope([1, 2, 3, 4, 5, 6, 7, 8], 4, 8)).toBe(true);
    expect(
      resourceTrendFailures(
        Array.from({ length: 8 }, (_, index) => ({
          rssBytes: 100 + index * 10,
          activeResourceCount: 2 + index,
          fdCount: 4 + index,
        })),
        {
          windowSize: 8,
          rssGrowthBytes: 40,
          activeResourceGrowth: 4,
          fdGrowth: 4,
        },
      ),
    ).toEqual(['rss', 'active-resources', 'file-descriptors']);
  });

  test('allows bounded allocator noise and stable resource counts', () => {
    expect(hasSustainedPositiveSlope([10, 11, 10, 12, 11, 12, 11, 12], 4, 8)).toBe(false);
    expect(
      resourceTrendFailures(
        Array.from({ length: 8 }, (_, index) => ({
          rssBytes: 100 + (index % 2),
          activeResourceCount: 2,
        })),
        {
          windowSize: 8,
          rssGrowthBytes: 4,
          activeResourceGrowth: 1,
          fdGrowth: 1,
        },
      ),
    ).toEqual([]);
  });
});
