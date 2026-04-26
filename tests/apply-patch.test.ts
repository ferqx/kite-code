import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePatch, applyPatch } from "../src/tools/apply-patch";

function createWorkspace(): string {
  const dir = join(tmpdir(), `openpx-patch-${Math.random().toString(36).slice(2, 8)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("apply_patch parser", () => {
  test("parses Add File operation", () => {
    const patch = `*** Begin Patch
*** Add File: hello.txt
+Hello, World!
+Second line
*** End Patch`;

    const ops = parsePatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("add");
    if (ops[0].kind === "add") {
      expect(ops[0].file).toBe("hello.txt");
      expect(ops[0].lines).toEqual(["Hello, World!", "Second line"]);
    }
  });

  test("parses Delete File operation", () => {
    const patch = `*** Begin Patch
*** Delete File: old.txt
*** End Patch`;

    const ops = parsePatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("delete");
    if (ops[0].kind === "delete") {
      expect(ops[0].file).toBe("old.txt");
    }
  });

  test("parses Update File operation with hunks", () => {
    const patch = `*** Begin Patch
*** Update File: src/app.ts
@@ greet function
 console.log
-hello
+Hello, World!
 done
*** End Patch`;

    const ops = parsePatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("update");
    if (ops[0].kind === "update") {
      expect(ops[0].file).toBe("src/app.ts");
      expect(ops[0].chunks).toHaveLength(1);
      const chunk = ops[0].chunks[0];
      expect(chunk.header).toBe("greet function");
      expect(chunk.contextBefore).toEqual(["console.log"]);
      expect(chunk.oldLines).toEqual(["hello"]);
      expect(chunk.newLines).toEqual(["Hello, World!"]);
      expect(chunk.contextAfter).toEqual(["done"]);
    }
  });

  test("parses Update with Move to", () => {
    const patch = `*** Begin Patch
*** Update File: old.ts
*** Move to: new.ts
@@
-old
+new
*** End Patch`;

    const ops = parsePatch(patch);
    expect(ops[0].kind).toBe("update");
    if (ops[0].kind === "update") {
      expect(ops[0].file).toBe("old.ts");
      expect(ops[0].moveTo).toBe("new.ts");
    }
  });

  test("parses multiple operations in one patch", () => {
    const patch = `*** Begin Patch
*** Add File: a.txt
+aaa
*** Update File: b.txt
@@
-bbb
+BBB
*** Delete File: c.txt
*** End Patch`;

    const ops = parsePatch(patch);
    expect(ops).toHaveLength(3);
    expect(ops[0].kind).toBe("add");
    expect(ops[1].kind).toBe("update");
    expect(ops[2].kind).toBe("delete");
  });

  test("throws on missing Begin Patch", () => {
    expect(() => parsePatch("*** Add File: x.txt\n+line")).toThrow(
      'Expected "*** Begin Patch"',
    );
  });

  test("parses empty patch", () => {
    const ops = parsePatch("*** Begin Patch\n*** End Patch");
    expect(ops).toHaveLength(0);
  });
});

describe("apply_patch applier", () => {
  test("applies Add File", () => {
    const ws = createWorkspace();
    const result = applyPatch(ws, `*** Begin Patch
*** Add File: hello.txt
+Hello
+World
*** End Patch`);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("A hello.txt");
    expect(readFileSync(join(ws, "hello.txt"), "utf8")).toBe("Hello\nWorld\n");
  });

  test("applies Delete File", () => {
    const ws = createWorkspace();
    writeFileSync(join(ws, "old.txt"), "garbage");
    expect(existsSync(join(ws, "old.txt"))).toBe(true);

    const result = applyPatch(ws, `*** Begin Patch
*** Delete File: old.txt
*** End Patch`);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("D old.txt");
    expect(existsSync(join(ws, "old.txt"))).toBe(false);
  });

  test("applies Update File with context match", () => {
    const ws = createWorkspace();
    writeFileSync(join(ws, "config.ts"), "  debug: false,\n  verbose: true,\n  env: prod,\n");

    const result = applyPatch(ws, `*** Begin Patch
*** Update File: config.ts
@@
  debug: false,
-  verbose: true,
+  verbose: false,
  env: prod,
*** End Patch`);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("M config.ts");
    const content = readFileSync(join(ws, "config.ts"), "utf8");
    expect(content).toContain("debug: false");
    expect(content).toContain("verbose: false");
    expect(content).not.toContain("verbose: true");
  });

  test("applies Update with Move to", () => {
    const ws = createWorkspace();
    writeFileSync(join(ws, "old.ts"), "old content\n");

    const result = applyPatch(ws, `*** Begin Patch
*** Update File: old.ts
*** Move to: new.ts
@@
-old content
+new content
*** End Patch`);

    expect(result.ok).toBe(true);
    expect(existsSync(join(ws, "old.ts"))).toBe(false);
    expect(readFileSync(join(ws, "new.ts"), "utf8")).toBe("new content\n");
  });

  test("reports error when context cannot be found", () => {
    const ws = createWorkspace();
    writeFileSync(join(ws, "file.txt"), "this is\ncompletely\ndifferent\n");

    const result = applyPatch(ws, `*** Begin Patch
*** Update File: file.txt
@@
-something
+other
*** End Patch`);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Cannot find matching lines");
  });

  test("applies multiple operations in one patch", () => {
    const ws = createWorkspace();
    writeFileSync(join(ws, "update.txt"), "before\nline\n");

    const result = applyPatch(ws, `*** Begin Patch
*** Add File: new.txt
+hello
*** Update File: update.txt
@@
-before
+after
*** End Patch`);

    expect(result.ok).toBe(true);
    expect(existsSync(join(ws, "new.txt"))).toBe(true);
    expect(readFileSync(join(ws, "update.txt"), "utf8")).toBe("after\nline\n");
    expect(result.summary).toContain("A new.txt");
    expect(result.summary).toContain("M update.txt");
  });

  test("creates parent directories for new files", () => {
    const ws = createWorkspace();
    const result = applyPatch(ws, `*** Begin Patch
*** Add File: deep/nested/file.txt
+content
*** End Patch`);

    expect(result.ok).toBe(true);
    expect(readFileSync(join(ws, "deep/nested/file.txt"), "utf8")).toBe("content\n");
  });

  test("applies end-of-file addition", () => {
    const ws = createWorkspace();
    writeFileSync(join(ws, "eof.ts"), "line1\nline2\n");

    const result = applyPatch(ws, `*** Begin Patch
*** Update File: eof.ts
@@
+line3
*** End of File
*** End Patch`);

    expect(result.ok).toBe(true);
    expect(readFileSync(join(ws, "eof.ts"), "utf8")).toBe("line1\nline2\nline3\n");
  });

  test("fuzzy matches Unicode dashes", () => {
    const ws = createWorkspace();
    // 使用 EN DASH (\u2013) / Use EN DASH
    writeFileSync(join(ws, "unicode.py"), "import foo \u2013 local\nprint(1)\n");

    // 补丁使用 ASCII dash / Patch uses ASCII dash
    const result = applyPatch(ws, `*** Begin Patch
*** Update File: unicode.py
@@
-import foo - local
+import bar - remote
*** End Patch`);

    expect(result.ok).toBe(true);
    expect(readFileSync(join(ws, "unicode.py"), "utf8")).toContain("import bar");
  });
});
