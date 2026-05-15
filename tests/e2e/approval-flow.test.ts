import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTuiE2E } from "./mock-agent";
import { approvalFlow } from "./scenarios/approval-flow";

const FIXTURES_DIR = join(import.meta.dir!, "fixtures", "approval-flow");

function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

function loadFixture(name: string): string | null {
  const p = fixturePath(name);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8");
}

function saveFixture(name: string, content: string): void {
  if (!existsSync(FIXTURES_DIR)) mkdirSync(FIXTURES_DIR, { recursive: true });
  writeFileSync(fixturePath(name), content, "utf-8");
}

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

const UPDATE_SNAPSHOTS = Bun.argv.includes("--update-snapshots") ||
  process.env.UPDATE_SNAPSHOTS === "true";

describe("approval flow E2E", () => {
  test("snapshot 1: approval waiting state", async () => {
    const result = await runTuiE2E(approvalFlow);
    expect(result.pass).toBe(true);
    expect(result.snapshots.length).toBe(2);

    const snap = result.snapshots[0];
    expect(snap.reason).toBe("approval-wait");

    const ansiExpected = loadFixture("001.ansi");
    if (UPDATE_SNAPSHOTS || ansiExpected === null) {
      saveFixture("001.ansi", snap.ansi);
      saveFixture("001.state.json", JSON.stringify(snap.state, null, 2));
    } else {
      const diff = diffAnsi(snap.ansi, ansiExpected);
      if (diff) {
        console.log("\n── diff: fixtures/approval-flow/001.ansi ──");
        console.log(diff);
      }
      expect(snap.ansi).toBe(ansiExpected);
    }
  });

  test("snapshot 2: terminal state after approval", async () => {
    const result = await runTuiE2E(approvalFlow);
    expect(result.pass).toBe(true);

    const snap = result.snapshots[1];
    expect(snap.reason).toBe("terminal");

    const ansiExpected = loadFixture("002.ansi");
    if (UPDATE_SNAPSHOTS || ansiExpected === null) {
      saveFixture("002.ansi", snap.ansi);
      saveFixture("002.state.json", JSON.stringify(snap.state, null, 2));
    } else {
      const diff = diffAnsi(snap.ansi, ansiExpected);
      if (diff) {
        console.log("\n── diff: fixtures/approval-flow/002.ansi ──");
        console.log(diff);
      }
      expect(snap.ansi).toBe(ansiExpected);
    }
  });
});
