import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const companions = [
  {
    path: 'scripts/release/entrypoints/coordinator.ts',
    main: 'runKiteCoordinatorMain',
    factory: 'createProductionKiteCoordinatorComposition',
  },
  {
    path: 'scripts/release/entrypoints/worker.ts',
    main: 'runWorkspaceWorkerMain',
    factory: 'createProductionWorkspaceWorkerRuntime',
  },
  {
    path: 'scripts/release/entrypoints/gateway.ts',
    main: 'runWebGatewayMain',
    factory: 'createProductionWebGatewayCarrier',
  },
] as const;

describe('managed companion release entrypoints', () => {
  for (const companion of companions) {
    test(`${companion.path} delegates to its exact main with its production factory`, () => {
      const source = readFileSync(companion.path, 'utf8');
      expect(source).toContain(companion.main);
      expect(source).toContain(companion.factory);
      expect(source).toContain('process.argv.slice(2)');
      expect(source).toContain('environment: process.env');
      expect(source).not.toContain("throw new Error('not implemented')");
    });
  }
});
