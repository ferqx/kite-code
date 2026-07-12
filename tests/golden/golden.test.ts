import { describe, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type GoldenFixture, runGoldenTest } from './run';

const fixturesDir = join(import.meta.dir, 'fixtures');
const fixtures = readdirSync(fixturesDir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as GoldenFixture);

describe('runtime golden fixtures', () => {
  for (const fixture of fixtures) {
    test(fixture.name, async () => {
      await runGoldenTest(fixture);
    });
  }
});
