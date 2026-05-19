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
      "ALWAYS call read_file BEFORE edit_file so old_string matches exactly. " +
      "Do NOT use shell commands (cat, head, tail, sed) to read files — use read_file instead. " +
      "Do NOT use read_file to list directories or search across multiple files — use shell_execute intent=inspect for that.",
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
      "ALWAYS call read_file first to get the exact content for old_string. " +
      "Do NOT use shell commands (sed -i, awk, echo >, tee) to edit files — use edit_file instead. " +
      "Do NOT use edit_file for creating new files — use write_file. " +
      "Do NOT use edit_file to rewrite the entire file — use write_file.",
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
      "Use for creating files that don't exist yet, or replacing entire file content. " +
      "Do NOT use shell redirection (>, >>, tee) or heredoc to write files — use write_file instead. " +
      "Do NOT use write_file for small targeted edits — use read_file + edit_file instead. " +
      "write_file replaces ALL content; any lines not in 'content' will be gone.",
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
      "This is the LAST RESORT for terminal operations — prefer dedicated tools whenever available: " +
      "use read_file to read files, edit_file/write_file to modify files, not shell commands like cat/sed/echo. " +
      "Use shell_execute for: running test suites (bun test), typecheck/lint (bun run typecheck), " +
      "installing dependencies (bun install), git operations, and other terminal-only tasks. " +
      "Set intent=inspect for read-only exploration (listing files, searching, git status/diff/log) — these bypass approval. " +
      "Set intent=verify for tests/typecheck/lint, intent=test for test suites, intent=build for compile/install, intent=git for version control, intent=other for everything else. " +
      "Write a short human-readable description so the user can understand what the command does at a glance. " +
      "Include objective, justification, expected_observation, and failure_strategy when the command needs user approval. " +
      "Mention a grant_request (approve_once | same_command | full_access) if the command requires approval.",
    commonMistakes:
      "Using shell_execute to read files (cat, head, tail, sed) — use read_file instead. " +
      "Using shell_execute to edit files (sed -i, echo >, tee, heredoc) — use edit_file or write_file instead. " +
      "Running destructive commands (rm -rf, git reset --hard, curl | sh, chmod -R) — denied by default. " +
      "Missing description field — always provide a short human-readable summary. " +
      "Using intent=inspect for mutating commands — the harness will reject these.",
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

export const SET_AUTHORIZATION_MODE_CONTRACT: ToolContract = {
  name: "set_authorization_mode",
  sections: {
    whenToUse:
      "Switch between default (require user confirmation for dangerous tools) and full_access " +
      "(auto-execute all tools without confirmation) authorization modes. " +
      "Call ONLY when the user explicitly requests a mode change, e.g. 'don't ask me for confirmation' or 'switch to auto mode'. " +
      "Do NOT call this tool without an explicit user request to change authorization mode. " +
      "This tool affects how other tools (shell_execute, write_file, edit_file) are authorized — " +
      "it does not read or write workspace files itself.",
    commonMistakes:
      "Calling set_authorization_mode without the user explicitly asking for a mode change. " +
      "Calling it excessively — one call is sufficient to change the mode for the entire thread.",
    outputFormat:
      "JSON with ok: true and the new mode value (default or full_access). " +
      "This tool always succeeds — if mode is already the requested value, it is a no-op.",
    failureHandling:
      "This tool always succeeds. If the mode parameter is invalid, it defaults to 'default'. " +
      "There is no error state to recover from.",
  },
  description: "",
};
SET_AUTHORIZATION_MODE_CONTRACT.description = buildDescription(SET_AUTHORIZATION_MODE_CONTRACT.sections);

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
  ["set_authorization_mode", SET_AUTHORIZATION_MODE_CONTRACT],
  ["apply_patch", APPLY_PATCH_CONTRACT],
]);
