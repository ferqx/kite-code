import { APPLY_PATCH_DESCRIPTION } from "./apply-patch";

export interface ToolContractSection {
  /** When to use this tool, AND when to use an alternative tool instead */
  whenToUse: string;
  /** Common failure patterns the model should avoid */
  commonMistakes: string;
  /** Expected output format and key field descriptions */
  outputFormat: string;
  /** How to handle failure: interpret errors and recover */
  failureHandling: string;
}

export interface ToolContract {
  name: string;
  description: string;
  sections: ToolContractSection;
}

function buildDescription(sections: ToolContractSection): string {
  return [
    sections.whenToUse,
    `\nCommon mistakes: ${sections.commonMistakes}`,
    `\nOutput: ${sections.outputFormat}`,
    `\nFailure: ${sections.failureHandling}`,
  ].join("");
}

export const READ_FILE_CONTRACT: ToolContract = {
  name: "read_file",
  sections: {
    whenToUse:
      "Read a file from the workspace with line numbers. " +
      "Use this to inspect file contents, verify changes, or understand code structure. " +
      "Use offset/limit for long files. " +
      "Do NOT use this to list directories or search across files — use shell_execute intent=inspect for that.",
    commonMistakes:
      "Editing a file without reading it first — edit_file will fail because old_string won't match. " +
      "Assuming file content without verifying — always read first. " +
      "Reading large files without offset/limit, wasting context. " +
      "Using an absolute path when a relative workspace path is expected.",
    outputFormat:
      "JSON: ok (boolean), content (line-numbered text: '  1|line content'), error (empty on success). " +
      "File not found: ok: false with error message.",
    failureHandling:
      "If file not found: use shell_execute intent=inspect to locate the correct path, then retry. " +
      "If offset is beyond file length: reduce or remove offset. " +
      "If path is unknown: explore the workspace with shell_execute first, then retry read_file.",
  },
  description: "",
};
READ_FILE_CONTRACT.description = buildDescription(READ_FILE_CONTRACT.sections);

export const EDIT_FILE_CONTRACT: ToolContract = {
  name: "edit_file",
  sections: {
    whenToUse:
      "Replace specific text in an existing file. Use for targeted, small-to-medium edits. " +
      "Do NOT use for creating new files — use write_file. " +
      "Do NOT use to rewrite the entire file — use write_file.",
    commonMistakes:
      "old_string doesn't match the file exactly — whitespace, indentation, or blank lines differ. " +
      "Calling edit_file without read_file first, so old_string is guesswork. " +
      "Same old_string appears multiple times without replace_all: true — causes duplicate-match error. " +
      "Not including enough surrounding context in old_string to make it unique.",
    outputFormat:
      "JSON: ok (boolean), replacements (count), fromLine/toLine (line range), error (empty on success). " +
      "Success: 'Replaced N occurrence(s) at line L1-L2'.",
    failureHandling:
      "If old_string not found: re-read the file with read_file, then retry with verified content. " +
      "If duplicate match: add more surrounding context to old_string (preferred) or set replace_all: true. " +
      "Always verify the edit with read_file afterward.",
  },
  description: "",
};
EDIT_FILE_CONTRACT.description = buildDescription(EDIT_FILE_CONTRACT.sections);

export const WRITE_FILE_CONTRACT: ToolContract = {
  name: "write_file",
  sections: {
    whenToUse:
      "Create a new file or completely overwrite an existing file. " +
      "Do NOT use for small targeted edits — use read_file + edit_file instead. " +
      "Replaces ALL content; omitted lines are lost.",
    commonMistakes:
      "Using write_file for small changes instead of edit_file — wasteful and loses precision. " +
      "Overwriting an existing file without first calling read_file to verify its current content. " +
      "Forgetting that write_file replaces the entire file — every omitted line is lost.",
    outputFormat:
      "JSON: ok (boolean), lines (lines written), error (empty on success). " +
      "Success: 'Wrote N line(s) to path/to/file'. " +
      "Parent directories are created automatically.",
    failureHandling:
      "If write fails: verify the path is a valid relative workspace path. " +
      "If permission or boundary error: verify the path is inside the workspace. " +
      "If the file already exists and you only need partial changes: use read_file + edit_file.",
  },
  description: "",
};
WRITE_FILE_CONTRACT.description = buildDescription(WRITE_FILE_CONTRACT.sections);

export const SHELL_EXECUTE_CONTRACT: ToolContract = {
  name: "shell_execute",
  sections: {
    whenToUse:
      "Execute a shell command in the workspace. " +
      "Prefer read_file/edit_file/write_file for file operations; use shell_execute for tests, typecheck, " +
      "installs, git operations, and other terminal-only tasks. " +
      "Set intent=inspect for read-only exploration (listing files, searching, git status/diff/log) — these bypass approval. " +
      "Write a short human-readable description so the user understands what the command does. " +
      "For commands needing approval, include grant_request (approve_once | same_command | full_access).",
    commonMistakes:
      "Missing description field — always provide a short human-readable summary. " +
      "Using intent=inspect for mutating commands — the harness will reject these. " +
      "Running destructive commands (rm -rf, git reset --hard, curl | sh, chmod -R) — denied by default.",
    outputFormat:
      "JSON with fields: ok (boolean), command (executed command), exitCode (0=success), stdout, stderr. " +
      "If rejected by policy, ok: false with reason in stderr. " +
      "Check stderr for warnings even when exitCode is 0.",
    failureHandling:
      "If exitCode nonzero: read stderr, adjust command, retry. " +
      "If tests fail (intent=verify): read failure output, fix code, re-run. " +
      "If rejected by policy: check intent matches command type; add grant_request for approval. " +
      "If output empty but exitCode 0: try different flags or path.",
  },
  description: "",
};
SHELL_EXECUTE_CONTRACT.description = buildDescription(SHELL_EXECUTE_CONTRACT.sections);

export const UPDATE_PLAN_CONTRACT: ToolContract = {
  name: "update_plan",
  sections: {
    whenToUse:
      "Update the current plan state when tracking progress is materially helpful. " +
      "Plan steps describe goals, not tool invocations — don't list file edits or shell_execute calls. " +
      "Don't call update_plan for trivial actions — only when the user benefits from tracking.",
    commonMistakes:
      "Including tool calls (file edits, shell commands, installs) as plan steps instead of goals. " +
      "Overusing update_plan for trivial progress.",
    outputFormat:
      "JSON with ok: true and a plan object: name, description, status (pending|in_progress|completed), steps (array of {step, status}).",
    failureHandling:
      "This tool is a no-op; it always succeeds. " +
      "To change direction, call again with updated status or steps. " +
      "To finish, call with status: completed.",
  },
  description: "",
};
UPDATE_PLAN_CONTRACT.description = buildDescription(UPDATE_PLAN_CONTRACT.sections);

export const ASK_USER_CONTRACT: ToolContract = {
  name: "ask_user",
  sections: {
    whenToUse:
      "Ask the user one focused question when progress is blocked by uncertainty only the user can resolve. " +
      "Provide concrete answer options and context explaining why this blocks progress. " +
      "Do NOT ask trivial questions — inspect the workspace with read_file/shell_execute first. " +
      "Do NOT over-use — interrupts frustrate users. " +
      "In plan mode: use to clarify requirements before producing a plan.",
    commonMistakes:
      "Asking vague questions without concrete options for the user to choose from. " +
      "Asking too many questions in sequence without acting on answers already received. " +
      "Using ask_user for questions the model could answer by reading workspace files. " +
      "Asking a question without providing any options at all.",
    outputFormat:
      "This tool triggers a user_input interrupt handled by the harness. It returns ok: false (the harness intercepts it). " +
      "Response includes question (string), options (array of {id, label, description?}), allow_free_text (boolean, default true), and context (string).",
    failureHandling:
      "This tool always triggers an interrupt — ok: false is expected and not an error. " +
      "The user's response will be injected as the next message in the conversation. " +
      "If the ask_user call has schema errors (missing question or empty options), fix the parameters and try again. " +
      "Do NOT retry ask_user with the same question if the user doesn't answer; respect that the user may not want to answer.",
  },
  description: "",
};
ASK_USER_CONTRACT.description = buildDescription(ASK_USER_CONTRACT.sections);

export const READ_MCP_RESOURCE_CONTRACT: ToolContract = {
  name: "read_mcp_resource",
  sections: {
    whenToUse:
      "Read a resource (documentation, API spec, or other content) from an MCP server. " +
      "Use this to fetch external reference materials exposed by configured MCP servers. " +
      "ALWAYS use mcp__<server>__list_resources first to discover available URIs before calling read_mcp_resource. " +
      "Do NOT use read_mcp_resource for tools or prompts — use the dedicated mcp__<server>__<tool> functions instead. " +
      "Do NOT use read_mcp_resource for reading workspace files — use read_file instead. " +
      "This tool only accesses content explicitly exposed by the MCP server; it cannot read arbitrary files.",
    commonMistakes:
      "Calling read_mcp_resource without first discovering available URIs via list_resources — the call will fail with an unknown URI. " +
      "Using a wrong server name — verify the server is connected via /mcp panel before calling. " +
      "Assuming the MCP server exposes resources when it only has tools — check the MCP panel to confirm resources are available. " +
      "Not handling the case where no MCP manager is available — calls fail gracefully with a clear message.",
    outputFormat:
      "JSON: ok (boolean), content (string — the resource text content), or stderr (string) on failure. " +
      "Multiple resource parts are joined with newlines. " +
      "No MCP manager: ok: false with stderr explaining configuration is needed.",
    failureHandling:
      "If 'Unknown MCP server': verify the server name matches the configuration in openpx.jsonc or .mcp.json. " +
      "If 'MCP server not connected': check /mcp panel for connection status and errors. " +
      "If 'No MCP manager available': configure mcpServers in openpx.jsonc to enable MCP integration. " +
      "If the resource content is unexpectedly empty: verify the URI with list_resources and try again.",
  },
  description: "",
};
READ_MCP_RESOURCE_CONTRACT.description = buildDescription(READ_MCP_RESOURCE_CONTRACT.sections);

export const APPLY_PATCH_CONTRACT: ToolContract = {
  name: "apply_patch",
  sections: {
    whenToUse:
      "Apply structured file edits using the Codex-style patch format. " +
      "Use apply_patch for making multiple coordinated file changes in one operation — add, update, delete, and move files in a single patch. " +
      "Do NOT use apply_patch for single-file simple edits — use read_file + edit_file instead. " +
      "Do NOT use apply_patch when a single edit_file call is sufficient; the patch format adds overhead for simple changes. " +
      "Prefer apply_patch when you need to create new files, delete files, or restructure the project alongside code changes.",
    commonMistakes:
      "Not providing enough context lines (2-3 lines minimum around each change) for reliable matching — patches with no context fail on whitespace or formatting differences. " +
      "Creating patches with wrong old lines that don't match actual file content — always use read_file first to verify exact content. " +
      "Forgetting to wrap patches in *** Begin Patch / *** End Patch markers. " +
      "Using absolute paths in file operations — all paths must be relative to the workspace. " +
      "Including only changed lines without surrounding context lines (marked with space prefix).",
    outputFormat:
      "JSON with fields: ok (boolean), path (primary affected file path), message (status message), summary (git-style list: D deleted, A added, M modified files). " +
      "On parse error, returns ok: false with the error line number and description.",
    failureHandling:
      "If the patch fails because context lines don't match, re-read the target files with read_file, then reconstruct the patch with verified context. " +
      "If a specific file operation fails (file not found, path outside workspace), check the path is correct and relative. " +
      "If the patch parse is invalid (missing *** Begin Patch, malformed operations), check the patch format against the specification in the description. " +
      "For context-matching failures, try adding more context lines or simplifying the hunk to match only old_lines without context.",
  },
  description: APPLY_PATCH_DESCRIPTION,
};

export const TASK_CONTRACT: ToolContract = {
  name: "task",
  sections: {
    whenToUse:
      "Dispatch a task to a specialized sub-agent with an isolated context window. " +
      "Use for parallel work (multiple sub-agents running simultaneously), role-specific work " +
      "(explore for search, code for implementation, review for quality checks), " +
      "and long-running autonomous tasks. " +
      "The task description MUST be self-contained — include ALL necessary context, file paths, " +
      "and specific instructions. Sub-agents cannot see the main conversation history. " +
      "Do NOT use for simple single-file reads or grep commands — use direct tools instead.",
    commonMistakes:
      "Providing a vague task description that the sub-agent cannot execute without conversation context. " +
      "Using 'code' for exploration tasks — use 'explore' for search and evidence gathering. " +
      "Not including specific file paths or function names in the task description. " +
      "Expecting the sub-agent to know about decisions made earlier in the conversation.",
    outputFormat:
      "JSON: ok (boolean), summary (string — the sub-agent's final output), toolCallCount (number), durationMs (number). " +
      "On error: ok: false with error field containing the error message.",
    failureHandling:
      "If the sub-agent times out (30 min): the task returns an error. Retry with a more focused task description. " +
      "If max concurrent sub-agents (10) are running: wait for running sub-agents to complete. " +
      "If the sub-agent returns unclear results: rephrase the task with more precise instructions and retry.",
  },
  description: "",
};
TASK_CONTRACT.description = buildDescription(TASK_CONTRACT.sections);

export const KNOWN_TOOL_NAMES = [
  "read_file",
  "edit_file",
  "write_file",
  "shell_execute",
  "read_mcp_resource",
  "update_plan",
  "ask_user",
  "apply_patch",
  "task",
] as const;

export const TOOL_CONTRACTS: ReadonlyMap<string, ToolContract> = new Map([
  ["read_file", READ_FILE_CONTRACT],
  ["edit_file", EDIT_FILE_CONTRACT],
  ["write_file", WRITE_FILE_CONTRACT],
  ["shell_execute", SHELL_EXECUTE_CONTRACT],
  ["read_mcp_resource", READ_MCP_RESOURCE_CONTRACT],
  ["update_plan", UPDATE_PLAN_CONTRACT],
  ["ask_user", ASK_USER_CONTRACT],
  ["apply_patch", APPLY_PATCH_CONTRACT],
  ["task", TASK_CONTRACT],
]);
