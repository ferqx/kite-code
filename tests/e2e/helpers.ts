import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTuiE2E } from "./mock-agent";
import type { Scenario } from "./types";

const UPDATE_SNAPSHOTS = Bun.argv.includes("--update-snapshots") ||
  process.env.UPDATE_SNAPSHOTS === "true";

const FIXTURES_ROOT = join(import.meta.dir!, "fixtures");

function diffAnsi(actual: string, expected: string): string | null {
  if (actual === expected) return null;
  const a = actual.split("\n");
  const b = expected.split("\n");
  const lines: string[] = [];
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const al = a[i] ?? "(missing)";
    const bl = b[i] ?? "(missing)";
    if (al !== bl) {
      lines.push(`  line ${i + 1}:`);
      lines.push(`-   ${bl}`);
      lines.push(`+   ${al}`);
    }
  }
  return lines.join("\n");
}

export function verifyScenario(
  scenarioName: string,
  scenario: Scenario,
  expectedSnapshotCount: number,
) {
  const fixtureDir = join(FIXTURES_ROOT, scenarioName);
  if (!existsSync(fixtureDir)) mkdirSync(fixtureDir, { recursive: true });

  const resultPromise = runTuiE2E(scenario);

  return {
    async verifyAll() {
      const result = await resultPromise;

      for (let i = 0; i < expectedSnapshotCount; i++) {
        if (!result.pass) {
          throw new Error(`[${scenarioName}] Scenario execution failed: ${result.error}`);
        }

        const snap = result.snapshots[i];
        if (!snap) {
          throw new Error(`[${scenarioName}] Expected ${expectedSnapshotCount} snapshots, got ${result.snapshots.length}`);
        }

        const idx = String(i + 1).padStart(3, "0");
        const ansiFile = join(fixtureDir, `${idx}.ansi`);
        const stateFile = join(fixtureDir, `${idx}.state.json`);

        if (UPDATE_SNAPSHOTS || !existsSync(ansiFile)) {
          writeFileSync(ansiFile, snap.ansi, "utf-8");
          writeFileSync(stateFile, JSON.stringify(snap.state, null, 2), "utf-8");
        } else {
          const ansiExpected = readFileSync(ansiFile, "utf-8");
          const diff = diffAnsi(snap.ansi, ansiExpected);
          if (diff) {
            const label = `[${scenarioName}] snapshot ${i + 1}`;
            throw new Error(`${label} ANSI diff:\n${diff}`);
          }
        }
      }
    },
  };
}
