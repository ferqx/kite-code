import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { loadAgentConfig } from "../src/config";
import { resumeCodeAgent, streamCodeAgent } from "../src/runner";
import { shellTool } from "../src/tools";
import type { AgentConfig } from "../src/config";
import type { ShellInput, ShellResult } from "../src/types";
import type { AgentEvent } from "../src/types";

interface ContinueInput {
  userId: string;
  threadId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: (input: ShellInput) => Promise<ShellResult>;
}

describe("real DeepSeek LangGraph code agent", () => {
  test(
    "answers model and context questions directly without tool approval",
    async () => {
      const env = createRealTestEnv("openpx-langgraph-direct-answer-agent");

      const events: AgentEvent[] = [];
      for await (const event of streamCodeAgent({
        task: "你当前是什么模型？上下文有多长",
        ...env,
      })) {
        events.push(event);
        if (event.type === "interrupt" || event.type === "final") {
          break;
        }
      }

      expect(JSON.stringify(events)).not.toContain("tool_approval");
      const final = events.find((event) => event.type === "final");
      expect(String(final?.data)).toContain(env.config.modelName);
      expect(String(final?.data)).toContain("上下文");
    },
    120_000,
  );

  test(
    "/plan produces a plan, blocks edits, and confirmation switches to builder mode",
    async () => {
      const env = createRealTestEnv("openpx-langgraph-plan-mode-agent");
      const fileName = "plan-mode-output.txt";
      const fileContent = "plan mode should not edit before confirmation";

      const planEvents = [];
      for await (const event of streamCodeAgent({
        task: `/plan Create ${fileName} with exact content "${fileContent}".`,
        ...env,
      })) {
        planEvents.push(event);
        if (event.type === "interrupt") {
          break;
        }
      }

      const modeInterrupt = planEvents.find((event) => event.type === "interrupt");
      expect(JSON.stringify(modeInterrupt)).toContain("mode_confirmation");
      expect(JSON.stringify(modeInterrupt)).toContain("builder");
      expect(JSON.stringify(planEvents)).not.toContain("tool_approval");
      expect(existsSync(join(env.workspace, fileName))).toBe(false);

      const executeEvents = await continueApproving(env, {
        approved: true,
        nextMode: "builder",
      });

      expect(JSON.stringify(executeEvents)).toContain("tool_approval");
      expect(JSON.stringify(executeEvents)).toContain("tool_call_id");
      expect(existsSync(join(env.workspace, fileName))).toBe(true);
      expect(readFileSync(join(env.workspace, fileName), "utf8")).toContain(fileContent);
    },
    120_000,
  );

  test(
    "builder mode runs a ReAct tool loop with persisted checkpoints",
    async () => {
      const env = createRealTestEnv("openpx-langgraph-react-agent");
      const fileName = "agent-output.txt";
      const fileContent = "hello from real deepseek langgraph agent";

      const startEvents = [];
      for await (const event of streamCodeAgent({
        task: `Create ${fileName} with exact content "${fileContent}".`,
        ...env,
      })) {
        startEvents.push(event);
        if (event.type === "interrupt") {
          break;
        }
      }

      expect(JSON.stringify(startEvents)).toContain("tool_approval");

      const resumedEvents = await continueApproving(env, { approved: true });

      expect(JSON.stringify(resumedEvents)).toContain("tool_call_id");
      expect(existsSync(join(env.workspace, fileName))).toBe(true);
      expect(readFileSync(join(env.workspace, fileName), "utf8")).toContain(fileContent);
      expect(existsSync(env.checkpointPath)).toBe(true);
    },
    120_000,
  );
});

function createRealTestEnv(name: string): ContinueInput & { task?: string } {
  const root = join(tmpdir(), name);
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  return {
    userId: `${name}-user`,
    threadId: `${name}-thread`,
    workspace,
    checkpointPath: join(dataDir, "checkpoints.sqlite"),
    config: loadAgentConfig(),
    shellExecutor: createTestShellExecutor(),
  };
}

async function continueApproving(
  input: ContinueInput,
  initialResume: { approved?: boolean; nextMode?: "builder" } = { approved: true },
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let resume = initialResume;

  for (let i = 0; i < 12; i++) {
    let interrupted = false;
    for await (const event of resumeCodeAgent({
      ...input,
      resume,
    })) {
      events.push(event);
      if (event.type === "final") {
        return events;
      }
      if (event.type === "interrupt") {
        interrupted = true;
        break;
      }
    }
    if (!interrupted) {
      return events;
    }
    resume = { approved: true };
  }

  return events;
}

function createTestShellExecutor() {
  return async (input: ShellInput): Promise<ShellResult> => {
    const bunWrite = parseBunWriteCommand(input.command);
    if (bunWrite) {
      mkdirSync(dirname(bunWrite.path), { recursive: true });
      await Bun.write(bunWrite.path, bunWrite.content);
    }
    const encoded = input.command.match(/\$encoded = '([^']+)'/)?.[1];
    const path = input.command.match(/Set-Content -LiteralPath '((?:''|[^'])+)'/)?.[1];
    if (encoded && path) {
      const target = path.replaceAll("''", "'");
      const content = Buffer.from(encoded, "base64").toString("utf8");
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, content);
    }
    const plainWrite = parsePlainWriteCommand(input.command);
    if (plainWrite) {
      const target = join(input.workspace, plainWrite.path.split(/[\\/]/).pop() ?? plainWrite.path);
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, plainWrite.content);
    }
    const readMatch =
      input.command.match(/Get-Content\s+"?([^"\s]+)"?(?:\s+-Raw)?/i) ??
      input.command.match(/cat\s+([^"\s]+)/i) ??
      input.command.match(/type\s+([^"\s]+)/i);
    if (readMatch) {
      const target = isAbsolute(readMatch[1]) ? readMatch[1] : join(input.workspace, readMatch[1]);
      return {
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: existsSync(target) ? readFileSync(target, "utf8") : "",
        stderr: "",
      };
    }

    return shellTool(input);
  };
}

function parseBunWriteCommand(command: string): { path: string; content: string } | null {
  if (!command.includes("fs.writeFileSync")) {
    return null;
  }
  const args = command.match(/'((?:'\\''|[^'])*)'/g)?.map((arg) =>
    unescapePosixShellArg(arg.slice(1, -1)),
  ) ?? [];
  const encoded = args.at(-1);
  const path = args.at(-2);
  if (!path || !encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    return null;
  }

  return {
    path,
    content: Buffer.from(encoded, "base64").toString("utf8"),
  };
}

function unescapePosixShellArg(value: string): string {
  return value.replaceAll("'\\''", "'");
}

function parsePlainWriteCommand(command: string): { path: string; content: string } | null {
  const setContent = command.match(
    /Set-Content\s+(?:-(?:LiteralPath|Path)\s+)?["']?([^"'\s]+)["']?\s+-Value\s+["']([^"']*)["']/i,
  );
  if (setContent) {
    return { path: setContent[1], content: setContent[2] };
  }

  const writeAllText = command.match(
    /\[System\.IO\.File\]::WriteAllText\(\s*["']([^"']+)["']\s*,\s*["']([^"']*)["']\s*\)/i,
  );
  if (writeAllText) {
    return { path: writeAllText[1], content: writeAllText[2] };
  }

  const redirect = command.match(/echo\s+["']([^"']*)["']\s*>\s*["']?([^"'\s]+)["']?/i);
  if (redirect) {
    return { path: redirect[2], content: redirect[1] };
  }

  return null;
}
