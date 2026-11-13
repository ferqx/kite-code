import { fileURLToPath } from 'node:url';

const register = fileURLToPath(new URL('./register.mjs', import.meta.url));
const runner = fileURLToPath(new URL('../run-test-files.ts', import.meta.url));
export const testRuntimeFlags = Object.freeze([
  '--no-global-search-paths',
  '--no-experimental-global-navigator',
  '--expose-gc',
  '--experimental-test-module-mocks',
  '--experimental-import-meta-resolve',
  '--import',
  register,
  '--import',
  fileURLToPath(new URL('./test-assets-loader.mjs', import.meta.url)),
]);

export function testNodeCommand(entry: string, args: readonly string[] = []): string[] {
  return [process.execPath, ...testRuntimeFlags, entry, ...args];
}

export function testFileCommand(args: readonly string[]): string[] {
  return testNodeCommand(runner, args);
}
