import { createRequire } from 'node:module';

export { test } from 'bun:test';

// Load the same locked matcher library through its CommonJS entry in Bun.
export const { expect } = createRequire(import.meta.url)('expect');
