import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli";

describe("cli argument parsing", () => {
  test("run uses a fresh thread by default to avoid resuming stale interrupts", () => {
    const args = parseArgs(["run", "--task", "你当前是什么模型？上下文有多长"]);

    expect(args.task).toBe("你当前是什么模型？上下文有多长");
    expect(args.threadId).toStartWith("run-");
    expect(args.threadId).not.toBe("default-thread");
  });

  test("run accepts the task as positional text after npm consumes --task", () => {
    const args = parseArgs(["run", "你当前是什么模型？上下文有多长"]);

    expect(args.task).toBe("你当前是什么模型？上下文有多长");
  });

  test("run keeps an explicit thread when the user wants conversation continuity", () => {
    const args = parseArgs(["run", "--thread", "conversation-a", "--task", "hello"]);

    expect(args.threadId).toBe("conversation-a");
  });

  test("resume still targets the default thread when no thread is provided", () => {
    const args = parseArgs(["resume", "--approve"]);

    expect(args.threadId).toBe("default-thread");
  });

  test("run accepts an explicit mode flag", () => {
    const args = parseArgs(["run", "--mode", "plan", "--task", "Create hello.txt"]);

    expect(args.mode).toBe("plan");
  });
});
