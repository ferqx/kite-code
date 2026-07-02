import { APPLY_PATCH_DESCRIPTION } from './apply-patch';

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
  ].join('');
}

export const READ_FILE_CONTRACT: ToolContract = {
  name: 'read_file',
  sections: {
    whenToUse:
      'Read a file from the workspace with line numbers. ' +
      'Use this to inspect file contents, verify changes, or understand code structure. ' +
      'Use offset/limit for long files. ' +
      'Do NOT use this to list directories or search across files — use shell_execute intent=inspect for that.',
    commonMistakes:
      "Editing a file without reading it first — edit_file will fail because old_string won't match. " +
      'Assuming file content without verifying — always read first. ' +
      'Reading large files without offset/limit, wasting context. ' +
      'Using an absolute path when a relative workspace path is expected.',
    outputFormat:
      "JSON: ok (boolean), content (line-numbered text: '  1|line content'), error (empty on success). " +
      'File not found: ok: false with error message.',
    failureHandling:
      'If file not found: use shell_execute intent=inspect to locate the correct path, then retry. ' +
      'If offset is beyond file length: reduce or remove offset. ' +
      'If path is unknown: explore the workspace with shell_execute first, then retry read_file. ' +
      'If binary file detected (NUL byte): the file is rejected. Use shell_execute with file(1) or xxd for inspection. ' +
      'Use force: true only as a last resort to read binary content as text.',
  },
  description: '',
};
READ_FILE_CONTRACT.description = buildDescription(READ_FILE_CONTRACT.sections);

export const EDIT_FILE_CONTRACT: ToolContract = {
  name: 'edit_file',
  sections: {
    whenToUse:
      'Replace specific text in an existing file. Use for targeted, small-to-medium edits. ' +
      'old_string MUST come from verified content — a recent read_file, a shell tool output, ' +
      'or a file you just wrote. NEVER fabricate old_string from memory or guesswork. ' +
      'Do NOT use for creating new files — use write_file. ' +
      'Do NOT use to rewrite the entire file — use write_file.',
    commonMistakes:
      'Fabricating old_string from memory instead of using verified content — the #1 cause of edit failure. ' +
      "old_string doesn't match the file exactly — whitespace, indentation, or blank lines differ. " +
      'Same old_string appears multiple times without replace_all: true — causes duplicate-match error. ' +
      'Not including enough surrounding context in old_string to make it unique.',
    outputFormat:
      'JSON: ok (boolean), replacements (count), fromLine/toLine (line range), error (empty on success). ' +
      "Success: 'Replaced N occurrence(s) at line L1-L2'.",
    failureHandling:
      'If old_string not found: the tool auto-retries with 3 progressive fallback levels. ' +
      'Level 1: trimEnd (trailing whitespace mismatch). Level 2: per-line trim (leading/trailing whitespace mismatch). ' +
      'Only if all levels fail: re-read the file with read_file, then retry with exact content. ' +
      "For intentional whitespace-insensitive matching, set match_mode: 'trimmed' to skip straight to per-line matching. " +
      'If duplicate match: add more surrounding context to old_string (preferred) or set replace_all: true. ' +
      'Always verify the edit with read_file afterward.',
  },
  description: '',
};
EDIT_FILE_CONTRACT.description = buildDescription(EDIT_FILE_CONTRACT.sections);

export const WRITE_FILE_CONTRACT: ToolContract = {
  name: 'write_file',
  sections: {
    whenToUse:
      "Create a new file, completely overwrite an existing file, or append to a file (mode: 'append'). " +
      'Do NOT use for small targeted edits — use read_file + edit_file instead. ' +
      'In overwrite mode (default), replaces ALL content; omitted lines are lost. ' +
      'In append mode, content is added at the end of the file.',
    commonMistakes:
      'Using write_file for small changes instead of edit_file — wasteful and loses precision. ' +
      'Overwriting an existing file without first calling read_file to verify its current content. ' +
      'Forgetting that write_file replaces the entire file — every omitted line is lost.',
    outputFormat:
      'JSON: ok (boolean), lines (lines written), error (empty on success). ' +
      "Success: 'Wrote N line(s) to path/to/file'. " +
      'Parent directories are created automatically.',
    failureHandling:
      'If write fails: verify the path is a valid relative workspace path. ' +
      'If permission or boundary error: verify the path is inside the workspace. ' +
      'If the file already exists and you only need partial changes: use read_file + edit_file.',
  },
  description: '',
};
WRITE_FILE_CONTRACT.description = buildDescription(WRITE_FILE_CONTRACT.sections);

export const SEARCH_CONTENT_CONTRACT: ToolContract = {
  name: 'search_content',
  sections: {
    whenToUse:
      'Search file contents by regex pattern using ripgrep (rg). ' +
      'Use this to find references, patterns, or specific code in the workspace. ' +
      'Use `path` to scope the search to a directory or file. ' +
      'Use `glob` to filter by file extension (e.g. "*.ts", "*.{ts,tsx}"). ' +
      'NEVER use shell_execute with grep/rg/ag — use search_content instead. ' +
      'NEVER use shell_execute with find/ls — use search_files instead.',
    commonMistakes:
      'Using shell_execute(grep/rg) instead of search_content. ' +
      'Using shell_execute(find/ls) instead of search_files. ' +
      'Searching too broadly without a glob filter — wastes context. ' +
      'Not reading the matched files after finding them — search is discovery, not understanding.',
    outputFormat:
      'JSON: ok (boolean), command (executed), stdout (matching lines with file:line:content), stderr. ' +
      'rg exit code 1 means NO matches — this is normal, not an error.',
    failureHandling:
      'rg exit code 1: no matches found. Narrow path or adjust pattern. ' +
      'rg not installed: falls back to grep. ' +
      'Empty output: try broader pattern or wider path scope.',
  },
  description: '',
};
SEARCH_CONTENT_CONTRACT.description = buildDescription(SEARCH_CONTENT_CONTRACT.sections);

export const SEARCH_FILES_CONTRACT: ToolContract = {
  name: 'search_files',
  sections: {
    whenToUse:
      'Find files by name pattern in the workspace. ' +
      'Use this to locate specific files by glob pattern (e.g. "*.test.ts", "**/config.*"). ' +
      'Pattern MUST include a file extension or name fragment — do NOT use bare "*" to dump the entire file tree. ' +
      'Use `path` to scope the search to a directory. ' +
      'NEVER use shell_execute with find/ls for file discovery — use search_files instead. ' +
      'NEVER use shell_execute with grep/rg for content search — use search_content instead.',
    commonMistakes:
      'Using bare "*" pattern — too broad, returns every file. Use "*.ts" or "*.test.*" instead. ' +
      'Using shell_execute(find/ls) instead of search_files. ' +
      'Using search_files to read file contents — use read_file for that. ' +
      'Pattern without wildcards — search_files is for discovery, use read_file for known paths.',
    outputFormat:
      'JSON: ok (boolean), command (executed), stdout (file paths, one per line), stderr.',
    failureHandling:
      'No files found: retry with broader pattern or different directory. ' +
      'Too many results: narrow pattern or scope to a subdirectory.',
  },
  description: '',
};
SEARCH_FILES_CONTRACT.description = buildDescription(SEARCH_FILES_CONTRACT.sections);

export const SHELL_EXECUTE_CONTRACT: ToolContract = {
  name: 'shell_execute',
  sections: {
    whenToUse:
      'Execute a shell command in the workspace. ' +
      'On Windows the shell is bash (Git Bash / MSYS2), NOT PowerShell or cmd.exe — always use Unix/shell syntax, never PowerShell cmdlets. ' +
      'Use forward-slashed POSIX paths (e.g. /d/app/src, not D:\\app\\src) — backslashes are bash escape characters and will break paths. ' +
      '**VERY IMPORTANT: You MUST avoid using search commands like `find` and `grep`. Instead use search_content, search_files, or task to search.** ' +
      '**ALWAYS use search_content for search tasks. NEVER invoke `grep` or `rg` as a shell_execute command.** ' +
      'Do NOT use shell_execute for: searching file contents (use search_content), finding files (use search_files), reading files (use read_file), editing files (use edit_file), writing files (use write_file). ' +
      'Use shell_execute ONLY for: tests, typecheck, builds, installs, git operations, and other terminal-only tasks. ' +
      'Set intent=inspect for read-only checks, intent=verify for tests/typecheck/lint, intent=test for test runs, intent=build for compilation, intent=git for git operations. ' +
      'For commands that start a TUI, dev server, watcher, or other long-running process, set timeout_ms (for example 10000) so the command returns after collecting startup output. ' +
      'Do not set timeout_ms for finite commands such as builds, installs, or test suites unless the user explicitly asks for a bounded smoke check. ' +
      'Write a short human-readable description so the user understands what the command does. ' +
      'For commands needing approval, include grant_request (approve_once | same_command | full_access).',
    commonMistakes:
      'Using shell_execute with grep/rg/find — use search_content/search_files instead. ' +
      'Missing description field — always provide a short human-readable summary. ' +
      'Using intent=inspect for mutating commands — the harness will reject these. ' +
      'Running interactive or long-running commands like `npm run tui`, `bun run dev`, or watch mode without timeout_ms — the tool will keep running until the process exits. ' +
      'Running destructive commands (rm -rf, git reset --hard, curl | sh, chmod -R) — denied by default.',
    outputFormat:
      'JSON with fields: ok (boolean), command (executed command), exitCode (0=success), stdout, stderr. ' +
      'If rejected by policy, ok: false with reason in stderr. ' +
      'Check stderr for warnings even when exitCode is 0.',
    failureHandling:
      'If exitCode nonzero: read stderr, adjust command, retry. ' +
      'rg (ripgrep) exit code 1 means NO matches found — this is NOT an error, do not retry. ' +
      'grep exit code 1 likewise means no matches. ' +
      'If tests fail (intent=verify): read failure output, fix code, re-run. ' +
      'If rejected by policy: check intent matches command type; add grant_request for approval. ' +
      'If output empty but exitCode 0: try different flags or path.',
  },
  description: '',
};
SHELL_EXECUTE_CONTRACT.description = buildDescription(SHELL_EXECUTE_CONTRACT.sections);

export const UPDATE_PLAN_CONTRACT: ToolContract = {
  name: 'update_plan',
  sections: {
    whenToUse:
      'FIRST CALL (plan proposal): Call update_plan with a thorough plan outline before any other tools. ' +
      'The plan is shown to the user for review. The user can: ' +
      '(a) approve — execution begins immediately; ' +
      '(b) supplement — provide feedback for you to revise the plan, then call update_plan again with the revised plan; ' +
      '(c) reject — discard the plan. ' +
      'If the user supplements, you receive their feedback as a rejection reason — revise the plan accordingly and call update_plan again. ' +
      'SUBSEQUENT CALLS (progress tracking): After plan approval, call update_plan to mark steps as in_progress/completed as you execute. ' +
      'Once the plan is approved, execution tools (read_file, edit_file, write_file, shell_execute) become available. ' +
      'Do NOT call update_plan for trivial single-step tasks.',
    outputFormat:
      'JSON: { ok: true, plan: { name, description, status, steps } }.\n' +
      '- name: short title (one line)\n' +
      '- description: FULL plan details — architecture, design decisions, file structure, ' +
      'dependencies, data flow, trade-offs. Put ALL substantive content here. ' +
      'This is what the user reviews, so make it thorough.\n' +
      '- status: pending / in_progress / completed\n' +
      '- steps: SHORT goal markers (3-6 words each) for progress tracking ONLY. ' +
      'Do NOT put architecture details or file lists in steps.',
    commonMistakes:
      'Writing detailed file-by-file descriptions in steps instead of the description field. ' +
      'Putting architecture and design in steps — steps are progress markers, not the plan. ' +
      'Including tool calls (file edits, shell commands, installs) as steps instead of goals. ' +
      'Overusing update_plan for trivial progress. ' +
      'Giving up after plan rejection — revise based on feedback and resubmit. ' +
      'Ignoring user supplement feedback and executing the original plan without revision — ' +
      'when the user supplements, you MUST revise the plan based on their feedback and call update_plan again.',
    failureHandling:
      'This tool is a no-op; it always succeeds. ' +
      'To change direction, call again with updated status or steps. ' +
      'To finish, call with status: completed.',
  },
  description: '',
};
UPDATE_PLAN_CONTRACT.description = buildDescription(UPDATE_PLAN_CONTRACT.sections);

export const ASK_USER_CONTRACT: ToolContract = {
  name: 'ask_user',
  sections: {
    whenToUse:
      'Ask the user focused questions when progress is blocked by uncertainty only the user can resolve. ' +
      'Use the `questions` array to batch all unknowns into ONE call — ask everything at once rather than ' +
      'spreading clarifications across multiple interruptions. Each question gets its own options (max 3). ' +
      'Only use single-question mode (`question` + `options`) for simple choose-one scenarios. ' +
      'In plan mode: batch all pre-plan clarifications into one ask_user call before calling update_plan.',
    commonMistakes:
      'Making multiple ask_user calls in sequence instead of batching into one `questions` array. ' +
      'Asking vague questions without concrete options — always provide 2-3 options to help non-expert users decide. ' +
      'Using ask_user for questions the model could answer by reading workspace files. ' +
      'Asking a question without providing any options at all. ' +
      'Forgetting to set `recommended` on the most suitable option — users may not know which to pick.',
    outputFormat:
      'This tool triggers a user_input interrupt handled by the harness. It returns ok: false (the harness intercepts it). ' +
      'Single mode: `question` (string), `options` (array of {id, label, description?}, max 3), `recommended` (option id), `allow_free_text` (boolean, default true), `context` (string). ' +
      'Batch mode: `questions` (array of {id, question, options[max 3], recommended?, allow_free_text?}). ' +
      'Always mark exactly one option as `recommended` — the TUI renders it with a ⭐ marker.',
    failureHandling:
      'This tool always triggers an interrupt — ok: false is expected and not an error. ' +
      "The user's response will be injected as the next message in the conversation. " +
      'If the ask_user call has schema errors (missing question or empty options), fix the parameters and try again. ' +
      "Do NOT retry ask_user with the same question if the user doesn't answer; respect that the user may not want to answer.",
  },
  description: '',
};
ASK_USER_CONTRACT.description = buildDescription(ASK_USER_CONTRACT.sections);

export const READ_MCP_RESOURCE_CONTRACT: ToolContract = {
  name: 'read_mcp_resource',
  sections: {
    whenToUse:
      'Read a resource (documentation, API spec, or other content) from an MCP server. ' +
      'Use this to fetch external reference materials exposed by configured MCP servers. ' +
      'ALWAYS use mcp__<server>__list_resources first to discover available URIs before calling read_mcp_resource. ' +
      'Do NOT use read_mcp_resource for tools or prompts — use the dedicated mcp__<server>__<tool> functions instead. ' +
      'Do NOT use read_mcp_resource for reading workspace files — use read_file instead. ' +
      'This tool only accesses content explicitly exposed by the MCP server; it cannot read arbitrary files.',
    commonMistakes:
      'Calling read_mcp_resource without first discovering available URIs via list_resources — the call will fail with an unknown URI. ' +
      'Using a wrong server name — verify the server is connected via /mcp panel before calling. ' +
      'Assuming the MCP server exposes resources when it only has tools — check the MCP panel to confirm resources are available. ' +
      'Not handling the case where no MCP manager is available — calls fail gracefully with a clear message.',
    outputFormat:
      'JSON: ok (boolean), content (string — the resource text content), or stderr (string) on failure. ' +
      'Multiple resource parts are joined with newlines. ' +
      'No MCP manager: ok: false with stderr explaining configuration is needed.',
    failureHandling:
      "If 'Unknown MCP server': verify the server name matches the configuration in kite-code.jsonc or .mcp.json. " +
      "If 'MCP server not connected': check /mcp panel for connection status and errors. " +
      "If 'No MCP manager available': configure mcpServers in kite-code.jsonc to enable MCP integration. " +
      'If the resource content is unexpectedly empty: verify the URI with list_resources and try again.',
  },
  description: '',
};
READ_MCP_RESOURCE_CONTRACT.description = buildDescription(READ_MCP_RESOURCE_CONTRACT.sections);

/** @reserved — apply_patch 暂未注册为 Agent 工具，待需求确认后启用 / not yet registered as an agent tool */
export const APPLY_PATCH_CONTRACT: ToolContract = {
  name: 'apply_patch',
  sections: {
    whenToUse:
      'Apply structured file edits using the Codex-style patch format. ' +
      'Use apply_patch for making multiple coordinated file changes in one operation — add, update, delete, and move files in a single patch. ' +
      'Do NOT use apply_patch for single-file simple edits — use read_file + edit_file instead. ' +
      'Do NOT use apply_patch when a single edit_file call is sufficient; the patch format adds overhead for simple changes. ' +
      'Prefer apply_patch when you need to create new files, delete files, or restructure the project alongside code changes.',
    commonMistakes:
      'Not providing enough context lines (2-3 lines minimum around each change) for reliable matching — patches with no context fail on whitespace or formatting differences. ' +
      "Creating patches with wrong old lines that don't match actual file content — always use read_file first to verify exact content. " +
      'Forgetting to wrap patches in *** Begin Patch / *** End Patch markers. ' +
      'Using absolute paths in file operations — all paths must be relative to the workspace. ' +
      'Including only changed lines without surrounding context lines (marked with space prefix).',
    outputFormat:
      'JSON with fields: ok (boolean), path (primary affected file path), message (status message), summary (git-style list: D deleted, A added, M modified files). ' +
      'On parse error, returns ok: false with the error line number and description.',
    failureHandling:
      "If the patch fails because context lines don't match, re-read the target files with read_file, then reconstruct the patch with verified context. " +
      'If a specific file operation fails (file not found, path outside workspace), check the path is correct and relative. ' +
      'If the patch parse is invalid (missing *** Begin Patch, malformed operations), check the patch format against the specification in the description. ' +
      'For context-matching failures, try adding more context lines or simplifying the hunk to match only old_lines without context.',
  },
  description: APPLY_PATCH_DESCRIPTION,
};

export const TASK_CONTRACT: ToolContract = {
  name: 'task',
  sections: {
    whenToUse:
      'Dispatch a task to a specialized sub-agent with an isolated context window. ' +
      'Use for parallel work (multiple sub-agents running simultaneously), role-specific work ' +
      '(explore for search, code for implementation, review for quality checks), ' +
      'and long-running autonomous tasks. ' +
      'The task description MUST be self-contained — include ALL necessary context, file paths, ' +
      'and specific instructions. Sub-agents cannot see the main conversation history. ' +
      'Do NOT use for simple single-file reads or grep commands — use direct tools instead.',
    commonMistakes:
      'Providing a vague task description that the sub-agent cannot execute without conversation context. ' +
      "Using 'code' for exploration tasks — use 'explore' for search and evidence gathering. " +
      'Not including specific file paths or function names in the task description. ' +
      'Expecting the sub-agent to know about decisions made earlier in the conversation.',
    outputFormat:
      "JSON: ok (boolean), summary (string — the sub-agent's final output), toolCallCount (number), durationMs (number). " +
      'On error: ok: false with error field containing the error message.',
    failureHandling:
      'If the sub-agent times out (30 min): the task returns an error. Retry with a more focused task description. ' +
      'If max concurrent sub-agents (10) are running: wait for running sub-agents to complete. ' +
      'If the sub-agent returns unclear results: rephrase the task with more precise instructions and retry.',
  },
  description: '',
};
TASK_CONTRACT.description = buildDescription(TASK_CONTRACT.sections);

export const WEB_FETCH_CONTRACT: ToolContract = {
  name: 'web_fetch',
  sections: {
    whenToUse:
      'Fetch and extract the main content from a public web page using Mozilla Readability (Firefox Reader Mode). ' +
      'Best for text-heavy HTML pages: documentation, API references, blog posts, news articles, Wikipedia. ' +
      'Also works for GitHub issue/PR pages, technical forums, Q&A sites like StackOverflow. ' +
      'Supports non-HTML formats too: plain text (.txt/.md/.log), JSON API responses, XML/RSS feeds, CSV files — ' +
      'these are returned as raw content without extraction. ' +
      'Use this when the user provides a URL or when a URL appears from read_file or search_content results. ' +
      'Do NOT use for: search result pages, login/auth pages, file download links, ' +
      'interactive web apps (SPAs), or pages that require authentication. ' +
      'Do NOT use for internal/localhost URLs — these are blocked by SSRF protection.',
    commonMistakes:
      'Fetching search engine result pages or login portals — readability cannot extract meaningful content from forms and result listings. ' +
      'Fetching URLs that require login, session cookies, or authentication — the tool has no credentials. ' +
      'Fetching pages that are mostly JavaScript-rendered (SPAs) — readability needs server-rendered HTML. ' +
      'Fetching without verifying the URL points to an article/document page, not a search form or login portal. ' +
      'Fetching from sites that may be unreachable in certain network environments (e.g., foreign sites behind a firewall) — ' +
      'if the user is in mainland China, prefer domestic sites (Baidu, Zhihu, CSDN) when equivalent content exists. ' +
      'For very large pages like Wikipedia or detailed docs, set timeout_ms higher (e.g. 20000).',
    outputFormat:
      'JSON: ok (boolean), url (requested URL), final_url (after redirects), ' +
      'title (extracted page title, HTML only), content (Markdown for HTML, raw text for JSON/XML/CSV/plain), ' +
      'content_type (MIME type), truncated (boolean). ' +
      'On error: ok: false with error field explaining why.',
    failureHandling:
      'If HTTP 403 (Forbidden): the site likely has anti-bot protection (e.g., Zhihu articles) — do NOT retry the same URL, find the same information from a different source. ' +
      'If HTTP 429 (Rate Limited): the site is throttling requests — wait a few seconds or switch to a different domain. ' +
      'If HTTP 404: the page does not exist — verify the URL is correct. ' +
      'If blocked by robots.txt: the site disallows crawling — respect this, do NOT attempt to bypass. ' +
      'If content not extractable: the page is likely not an article (search results, login form, SPA) — this is expected, do NOT retry the same URL, switch to a different source. ' +
      'If timeout: increase timeout_ms (up to 30000) for large pages like Wikipedia, or try a mirror/alternative domain. ' +
      'If connection refused or DNS error: the site may be blocked in the current network environment — suggest the user check their proxy or try a domestic alternative. ' +
      'If blocked by SSRF: the URL is internal/private — do not attempt to access it.',
  },
  description: '',
};
WEB_FETCH_CONTRACT.description = buildDescription(WEB_FETCH_CONTRACT.sections);

export const KNOWN_TOOL_NAMES = [
  'read_file',
  'edit_file',
  'write_file',
  'shell_execute',
  'search_content',
  'search_files',
  'read_mcp_resource',
  'update_plan',
  'ask_user',
  'task',
  'web_fetch',
] as const;

/** 按名称查找工具契约 / Look up a tool contract by name */
export function getToolContract(toolName: string): ToolContract | undefined {
  return TOOL_CONTRACTS.get(toolName);
}

export const TOOL_CONTRACTS: ReadonlyMap<string, ToolContract> = new Map([
  ['read_file', READ_FILE_CONTRACT],
  ['edit_file', EDIT_FILE_CONTRACT],
  ['write_file', WRITE_FILE_CONTRACT],
  ['shell_execute', SHELL_EXECUTE_CONTRACT],
  ['search_content', SEARCH_CONTENT_CONTRACT],
  ['search_files', SEARCH_FILES_CONTRACT],
  ['read_mcp_resource', READ_MCP_RESOURCE_CONTRACT],
  ['update_plan', UPDATE_PLAN_CONTRACT],
  ['ask_user', ASK_USER_CONTRACT],
  ['task', TASK_CONTRACT],
  ['web_fetch', WEB_FETCH_CONTRACT],
]);
