import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli";

// 测试 CLI 命令行参数解析逻辑 / Test CLI argument parsing logic
describe("cli argument parsing", () => {
  // 验证 run 命令默认使用新线程，避免恢复过期的中断 / Verify run defaults to fresh thread to avoid stale interrupt resume
  test("run uses a fresh thread by default to avoid resuming stale interrupts", () => {
    const args = parseArgs(["run", "--task", "你当前是什么模型？上下文有多长"]);

    expect(args.task).toBe("你当前是什么模型？上下文有多长");
    expect(args.threadId).toStartWith("run-"); // 自动生成的线程 ID 以 run- 开头 / Auto-generated thread ID starts with run-
    expect(args.threadId).not.toBe("default-thread"); // 不使用 default-thread 避免冲突 / Not using default-thread to avoid collision
  });

  // 验证 --task 被 npm 消费后，run 命令能通过位置参数接收任务文本 / Verify run accepts task as positional argument after npm strips --task
  test("run accepts the task as positional text after npm consumes --task", () => {
    const args = parseArgs(["run", "你当前是什么模型？上下文有多长"]);

    expect(args.task).toBe("你当前是什么模型？上下文有多长");
  });

  // 验证用户显式指定线程时，run 命令保留该线程 ID / Verify run keeps explicit thread ID for conversation continuity
  test("run keeps an explicit thread when the user wants conversation continuity", () => {
    const args = parseArgs(["run", "--thread", "conversation-a", "--task", "hello"]);

    expect(args.threadId).toBe("conversation-a");
  });

  // 验证 resume 命令在未提供线程时默认使用 default-thread / Verify resume defaults to default-thread when no thread given
  test("resume still targets the default thread when no thread is provided", () => {
    const args = parseArgs(["resume", "--approve"]);

    expect(args.threadId).toBe("default-thread");
  });

  // 验证 run 命令支持显式的 --mode 标志 / Verify run accepts explicit --mode flag
  test("run accepts an explicit mode flag", () => {
    const args = parseArgs(["run", "--mode", "plan", "--task", "Create hello.txt"]);

    expect(args.mode).toBe("plan");
  });
});
