import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function collectFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

function isBunDefaultTestFile(path: string): boolean {
  return /\.(test|spec)\.[cm]?[tj]sx?$/.test(path);
}

describe("test discovery boundaries", () => {
  test("keeps real model suites out of Bun default test discovery", () => {
    const defaultTests = collectFiles(join(repoRoot, "tests"))
      .map((path) => relative(repoRoot, path))
      .filter(isBunDefaultTestFile)
      .filter((path) => path !== "tests/test-discovery.test.ts");
    const realDefaultTests = defaultTests.filter((path) => path.includes("real"));
    const liveModelDefaultTests = defaultTests.filter((path) => {
      const source = readFileSync(join(repoRoot, path), "utf8");
      return (
        /createDeepSeekModel\([\s\S]*?\)\.invoke\(/.test(source) ||
        /createChatModel\([\s\S]*?\)\.invoke\(/.test(source) ||
        source.includes("ensureRealModelAvailable(")
      );
    });

    expect(realDefaultTests).toEqual([]);
    expect(liveModelDefaultTests).toEqual([]);
  });

  test("keeps real model tests behind explicit scripts", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.test).toBe("bun test");
    expect(pkg.scripts?.["test:real"]).toBe("bun test ./tests/real-agent.real.ts");
    expect(pkg.scripts?.["test:real"]).not.toContain("proxy");
    expect(pkg.scripts?.["test:real:direct"]).toBeUndefined();
  });
});
