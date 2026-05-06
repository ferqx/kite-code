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
      "Read a file from the workspace to see its current content with line numbers. " +
      "Use this BEFORE edit_file to get the exact text to replace. " +
      "Use this to inspect file contents, verify changes, or understand code structure. " +
      "Do NOT use read_file when you need to search across multiple files — use shell_execute with intent=inspect and rg/grep. " +
      "Do NOT use it to list directory contents — use shell_execute with ls or find.",
    commonMistakes:
      "Editing a file without first calling read_file (causes edit_file to fail because old_string won't match). " +
      "Using an absolute path instead of a relative workspace path. " +
      "Assuming file content without verifying — always read first. " +
      "Reading large files without offset/limit, wasting context.",
    outputFormat:
      "JSON with fields: ok (boolean), content (line-numbered text like '  1|line content'), error (empty on success). " +
      "If the file does not exist, returns ok: false with error message.",
    failureHandling:
      "If file not found (ok: false), use shell_execute with intent=inspect and ls, find, or rg to locate the correct path. " +
      "If the path parameter is missing or empty, verify you provided it. " +
      "If offset is beyond file length, reduce or remove offset. " +
      "If you're unsure about the path, explore the workspace with shell_execute intent=inspect first, then retry read_file.",
  },
  description: "",
};
READ_FILE_CONTRACT.description = buildDescription(READ_FILE_CONTRACT.sections);

export const EDIT_FILE_CONTRACT: ToolContract = {
  name: "edit_file",
  sections: {
    whenToUse:
      "Replace specific text in an existing file. Use for targeted, small-to-medium edits. " +
      "ALWAYS call read_file first to see the exact content and line numbers, then construct old_string from that output. " +
      "Do NOT use edit_file for creating new files — use write_file. " +
      "Do NOT use edit_file for completely rewriting a file — use write_file. " +
      "Do NOT call edit_file without first calling read_file and verifying exact content.",
    commonMistakes:
      "old_string does not match file content exactly — whitespace, indentation, blank lines, or trailing spaces differ. " +
      "The same old_string appears multiple times in the file but replace_all is not set to true (edit_file will fail with a duplicate-match error). " +
      "Calling edit_file without calling read_file first, so old_string is based on guesswork rather than actual content. " +
      "Trying to edit a file that doesn't exist — use write_file for new files. " +
      "Not including enough surrounding lines in old_string to make it unique.",
    outputFormat:
      "JSON with fields: ok (boolean), replacements (number of occurrences replaced), fromLine and toLine (replacement line range), error (empty on success). " +
      "On success, stdout contains 'Replaced N occurrence(s) at line L1-L2'.",
    failureHandling:
      "If old_string is not found, re-read the file with read_file to verify current content, then retry with the correct old_string copied from the read_file output. " +
      "If duplicate match error (multiple occurrences without replace_all), add more surrounding context lines to old_string to make it unique (preferred), or set replace_all: true. " +
      "Always verify the edit succeeded by calling read_file on the edited region.",
  },
  description: "",
};
EDIT_FILE_CONTRACT.description = buildDescription(EDIT_FILE_CONTRACT.sections);

export const WRITE_FILE_CONTRACT: ToolContract = {
  name: "write_file",
  sections: {
    whenToUse:
      "Create a new file or completely overwrite an existing file with new content. " +
      "Use for creating files that don't exist yet, or when the entire file content must be replaced. " +
      "Do NOT use write_file for small targeted edits to existing files — use read_file + edit_file instead. " +
      "Do NOT use write_file to modify just a few lines; it replaces ALL content.",
    commonMistakes:
      "Using write_file for small changes instead of edit_file — this is wasteful and loses precision. " +
      "Accidentally overwriting an existing file without verifying its current content with read_file first. " +
      "Forgetting that write_file replaces ALL content; any lines not in 'content' will be gone.",
    outputFormat:
      "JSON with fields: ok (boolean), lines (number of lines written), error (empty on success). " +
      "On success, stdout contains 'Wrote N line(s) to path/to/file'.",
    failureHandling:
      "If writing fails, check that the path is a valid relative workspace path. " +
      "write_file automatically creates parent directories; if a permission or boundary error occurs, verify the path is inside the workspace. " +
      "If the file already exists and you only need partial changes, switch to read_file + edit_file.",
  },
  description: "",
};
WRITE_FILE_CONTRACT.description = buildDescription(WRITE_FILE_CONTRACT.sections);

export const SHELL_EXECUTE_CONTRACT: ToolContract = {
  name: "shell_execute",
  sections: {
    whenToUse:
      "Execute a shell command in the workspace with action envelope metadata. " +
      "Use intent=inspect for read-only exploration (ls, rg, grep, find, cat, git status, git diff, git log). " +
      "Use intent=verify for tests, typecheck, lint, or build verification (e.g. bun test, bun run typecheck). " +
      "Use intent=test for running test suites, intent=build for compilation or install, intent=git for version control mutations, intent=other for anything else. " +
      "Do NOT use shell_execute for reading file contents by path — use read_file. " +
      "Do NOT use shell_execute for editing files — use edit_file or write_file. " +
      "Always include objective, justification, expected_observation, and failure_strategy when they help the user review the command. " +
      "In plan mode, only intent=inspect with read-only commands is allowed; mutating commands will be rejected.",
    commonMistakes:
      "Using intent=inspect for commands that write or execute code — the harness will reject these. " +
      "Omitting the action envelope metadata (objective, justification, expected_observation, failure_strategy) when the command needs review. " +
      "Running destructive commands (rm -rf, git reset --hard, curl | sh, chmod -R, etc.) — these are denied by default. " +
      "Running commands that need approval without specifying a grant_request (approve_once, same_command, or full_access). " +
      "Using shell_execute to read files by name instead of using read_file.",
    outputFormat:
      "JSON with fields: ok (boolean), command (executed command), exitCode (0=success, nonzero=failure), stdout, stderr, and action (the action envelope metadata). " +
      "If the command is rejected by policy, ok is false with the rejection reason in stderr. " +
      "exitCode 0 still requires checking stderr for warnings.",
    failureHandling:
      "If exitCode is nonzero, read stderr for the error message and adjust the command accordingly. " +
      "If the intent was verify and tests fail, read the test failure output (in stdout/stderr), fix the relevant code, then re-run. " +
      "If the command was rejected by policy, check: (1) are you in plan mode with a non-read-only command? (2) did you use intent=inspect for a mutating command? " +
      "If the command needs approval and was denied, specify a grant_request in the next call. " +
      "If the command output is empty but exitCode is 0, check if the command needs a different flag or path.",
  },
  description: "",
};
SHELL_EXECUTE_CONTRACT.description = buildDescription(SHELL_EXECUTE_CONTRACT.sections);

export const UPDATE_PLAN_CONTRACT: ToolContract = {
  name: "update_plan",
  sections: {
    whenToUse:
      "Update the current plan state when tracking progress is materially helpful to the user. " +
      "Use this to communicate what steps you plan to take and to mark steps as completed. " +
      "Do NOT use update_plan to record file operations, shell_execute calls, or dependency installations — those are actual tool calls, not plan items. " +
      "Do NOT call update_plan excessively or for every tiny action — only when tracking materially helps. " +
      "The plan must not edit files, run commands, install dependencies, or mutate the workspace.",
    commonMistakes:
      "Including file edits, shell commands, or install steps in the plan's steps array — plan steps describe goals, not tool invocations. " +
      "Using update_plan as a substitute for actually executing tools — it is a state tracker, not an action executor. " +
      "Creating plans with workspace-mutating descriptions. " +
      "Overusing update_plan for trivial progress — only call it when the user benefits from seeing the tracking.",
    outputFormat:
      "JSON with ok: true (always) and a plan object containing name, description, status (pending|in_progress|completed), and steps (array of {step, status}). " +
      "This tool is a no-op state tracker; it always succeeds.",
    failureHandling:
      "This tool is a no-op that always returns success. There is no error state to recover from. " +
      "If the plan direction needs to change, call update_plan again with updated status or steps. " +
      "If the plan is complete, call update_plan with status: completed.",
  },
  description: "",
};
UPDATE_PLAN_CONTRACT.description = buildDescription(UPDATE_PLAN_CONTRACT.sections);

export const ASK_USER_CONTRACT: ToolContract = {
  name: "ask_user",
  sections: {
    whenToUse:
      "Ask the user one focused clarification question when progress is blocked by meaningful uncertainty that ONLY the user can resolve. " +
      "Provide concrete, actionable answer options and include context explaining why this question blocks progress. " +
      "Do NOT use ask_user for trivial confirmations or questions you can answer yourself by inspecting the workspace. " +
      "Do NOT over-use — each ask_user call interrupts the user, and multiple back-to-back calls frustrate them. " +
      "In plan mode, use this to clarify requirements and scope before producing a plan. " +
      "In builder mode, use this sparingly — prefer read_file and shell_execute with intent=inspect over asking the user.",
    commonMistakes:
      "Asking vague questions that lack concrete options for the user to choose from. " +
      "Asking too many questions in sequence without making progress on answers already received. " +
      "Not providing enough context for the user to understand trade-offs between options. " +
      "Using ask_user for questions the model could answer by reading workspace files or running inspect commands. " +
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

export const TOOL_CONTRACTS: ReadonlyMap<string, ToolContract> = new Map([
  ["read_file", READ_FILE_CONTRACT],
  ["edit_file", EDIT_FILE_CONTRACT],
  ["write_file", WRITE_FILE_CONTRACT],
  ["shell_execute", SHELL_EXECUTE_CONTRACT],
  ["update_plan", UPDATE_PLAN_CONTRACT],
  ["ask_user", ASK_USER_CONTRACT],
  ["apply_patch", APPLY_PATCH_CONTRACT],
]);
