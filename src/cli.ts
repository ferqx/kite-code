import { join, resolve } from "node:path";
import { loadAgentConfig } from "./config";
import { resumeCodeAgent, streamCodeAgent } from "./runner";
import type { AgentRunMode } from "./types";

export interface ParsedArgs {
  command: "run" | "resume" | "help";
  task?: string;
  threadId: string;
  userId: string;
  workspace: string;
  checkpointPath: string;
  mode: AgentRunMode;
  approve: boolean;
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    printHelp();
    return;
  }

  const config = loadAgentConfig();
  const events =
    args.command === "run"
      ? streamCodeAgent({
          task: args.task ?? "",
          userId: args.userId,
          threadId: args.threadId,
          workspace: args.workspace,
          checkpointPath: args.checkpointPath,
          config,
          mode: args.mode,
        })
      : resumeCodeAgent({
          userId: args.userId,
          threadId: args.threadId,
          workspace: args.workspace,
          checkpointPath: args.checkpointPath,
          config,
          resume: { approved: args.approve },
        });

  for await (const event of events) {
    console.log(JSON.stringify(event));
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] === "resume" ? "resume" : argv[0] === "run" ? "run" : "help";
  const cwd = process.cwd();
  const value = (name: string, fallback: string) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const explicitThread = value("--thread", "");
  const mode = parseMode(value("--mode", "auto"));

  return {
    command,
    task: command === "run" ? value("--task", positionalTask(argv)) : "",
    threadId: explicitThread || (command === "run" ? freshThreadId() : "default-thread"),
    userId: value("--user", "default-user"),
    workspace: resolve(value("--workspace", cwd)),
    checkpointPath: resolve(
      value("--checkpoints", join(cwd, ".openpx", "checkpoints.sqlite")),
    ),
    mode,
    approve: argv.includes("--approve"),
  };
}

function positionalTask(argv: string[]): string {
  if (argv[0] !== "run") {
    return "";
  }

  const optionNamesWithValues = new Set([
    "--task",
    "--thread",
    "--user",
    "--workspace",
    "--checkpoints",
    "--mode",
  ]);
  const parts: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const item = argv[index];
    if (optionNamesWithValues.has(item)) {
      index++;
      continue;
    }
    if (item.startsWith("--")) {
      continue;
    }
    parts.push(item);
  }
  return parts.join(" ").trim();
}

function parseMode(value: string): AgentRunMode {
  return value === "plan" || value === "builder" ? value : "auto";
}

function freshThreadId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function printHelp(): void {
  console.log(`Usage:
  bun run agent run --task "Create hello.txt with exact content \\"hi\\""
  bun run agent resume --thread default-thread --approve

Options:
  --task <text>          Task for run
  --thread <id>          LangGraph thread id
  --user <id>            User id for the run
  --workspace <path>     Tool workspace
  --checkpoints <path>   SQLite checkpoint path
  --mode <mode>          auto, builder, or plan
  --approve             Resume an interrupt with approval`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
