import { describe, expect, test } from 'bun:test';
import { epochMillisecondsToIsoUtc } from '../src/core/lease/utc-iso';

describe('pure UTC epoch formatter', () => {
  test('matches ISO UTC across day, leap-year, and expanded-year boundaries', () => {
    const timestamps = [
      -8_640_000_000_000_000,
      -62_167_219_200_001,
      -1,
      0,
      1,
      Date.parse('1999-12-31T23:59:59.999Z'),
      Date.parse('2000-02-29T23:59:59.999Z'),
      Date.parse('2024-02-29T23:59:59.999Z'),
      Date.parse('2026-12-31T23:59:59.999Z'),
      Date.parse('9999-12-31T23:59:59.999Z'),
      8_640_000_000_000_000,
    ];
    for (const timestamp of timestamps) {
      expect(epochMillisecondsToIsoUtc(timestamp)).toBe(new Date(timestamp).toISOString());
    }
    for (let index = 0; index <= 256; index += 1) {
      const timestamp = index * 33_589_000_000_000;
      expect(epochMillisecondsToIsoUtc(timestamp)).toBe(new Date(timestamp).toISOString());
      expect(epochMillisecondsToIsoUtc(-timestamp)).toBe(new Date(-timestamp).toISOString());
    }
  });

  test('rejects invalid or out-of-range values', () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      -8_640_000_000_000_001,
      8_640_000_000_000_001,
    ]) {
      expect(epochMillisecondsToIsoUtc(value)).toBeNull();
    }
  });
});
