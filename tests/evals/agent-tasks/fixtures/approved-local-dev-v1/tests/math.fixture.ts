import { expect, test } from 'bun:test';
import { multiply, subtract } from '../src/math';

test('synthetic arithmetic behavior', () => {
  expect(subtract(5, 3)).toBe(2);
  expect(multiply(5, 3)).toBe(15);
});
