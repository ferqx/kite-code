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

export function buildDescription(sections: ToolContractSection): string {
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
      'Do NOT use this to list directories or search across files — use search_files or search_content for that.',
    commonMistakes:
      "Editing a file without reading it first — edit_file will fail because old_string won't match. " +
      'Assuming file content without verifying — always read first. ' +
      'Reading large files without offset/limit, wasting context. ' +
      'Using an absolute path when a relative workspace path is expected.',
    outputFormat:
      "JSON: ok (boolean), content (line-numbered text: '  1|line content'), error (empty on success). " +
      'File not found: ok: false with error message.',
    failureHandling:
      'If file not found: use search_files to locate the correct path, then retry. ' +
      'If offset is beyond file length: reduce or remove offset. ' +
      'If path is unknown: explore the workspace with shell_execute first, then retry read_file. ' +
      'If binary file detected (NUL byte): the file cannot be read as text. Tell the user the file appears binary and ask how they want to proceed; shell_execute with file(1) or xxd can inspect it after approval.',
  },
  description: '',
};
READ_FILE_CONTRACT.description = buildDescription(READ_FILE_CONTRACT.sections);

export const READ_PLAN_CONTRACT: ToolContract = {
  name: 'read_plan',
  sections: {
    whenToUse:
      'Read a saved Plan Artifact by plan_id and version when revising a plan or verifying the exact persisted document. ' +
      'Use this instead of read_file for ~/.kite-code/plans artifacts; the runtime validates that the reference belongs to the active Task.',
    commonMistakes:
      'Reading an old version when the current review feedback points to a newer version. ' +
      'Using a filesystem path instead of plan_id and version. ' +
      'Submitting a plan without using the digest returned by the Artifact.',
    outputFormat:
      'JSON: ok, task_id, plan_id, version, structural_digest, title, body_markdown, and steps. ' +
      'The full body is returned only because the model explicitly requested read_plan.',
    failureHandling:
      'If the Artifact is missing or its digest does not match, do not recreate it from memory; save a new revision only after confirming the current Task and feedback.',
  },
  description: '',
};
READ_PLAN_CONTRACT.description = buildDescription(READ_PLAN_CONTRACT.sections);

export const EDIT_FILE_CONTRACT: ToolContract = {
  name: 'edit_file',
  sections: {
    whenToUse:
      'Replace specific text in an existing file. Use for targeted, small-to-medium edits. ' +
      'old_string MUST come from verified content — a recent read_file, a shell tool output, ' +
      'or a file you just wrote. NEVER fabricate old_string from memory or guesswork. ' +
      'Do NOT use for creating new files — use write_file. ' +
      'Do NOT use to rewrite the entire file — use write_file. ' +
      'CRITICAL: Do NOT issue multiple edit_file calls targeting the SAME file in a single turn. ' +
      'Each edit_file modifies the file immediately, invalidating subsequent old_string values ' +
      'that were based on the pre-edit content. Combine all edits to the same file into ONE ' +
      'edit_file call with a larger old_string/new_string range, or use write_file to rewrite ' +
      'the entire file if the changes are extensive.',
    commonMistakes:
      'Fabricating old_string from memory instead of using verified content — the #1 cause of edit failure. ' +
      "old_string doesn't match the file exactly — whitespace, indentation, or blank lines differ. " +
      'Same old_string appears multiple times without replace_all: true — causes duplicate-match error. ' +
      'Not including enough surrounding context in old_string to make it unique. ' +
      'Making multiple edit_file calls to the same file in one turn — each edit changes the file, ' +
      'causing subsequent old_string values to fail. Combine into one call instead.',
    outputFormat:
      'JSON: ok (boolean), replacements (count), fromLine/toLine (line range), error (empty on success). ' +
      "Success: 'Replaced N occurrence(s) at line L1-L2'.",
    failureHandling:
      'If old_string not found: matching is exact including whitespace — re-read the file with read_file and retry with the exact current content. ' +
      'If the file has not been read in this session: read_file is required before edit_file. ' +
      'If the file changed since your last read: it was modified externally — re-read it and retry. ' +
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
      'Create a new file or completely rewrite an existing file. ' +
      'Before rewriting an existing file, call read_file first to verify its current content — every omitted line is lost. ' +
      'Do NOT use for small targeted edits — use read_file + edit_file instead. ' +
      'To append content, use edit_file matching the file tail (old_string = trailing content, new_string = trailing content + the addition) or a shell redirect.',
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
      'Search file contents by regex pattern. ' +
      "Files and directories ignored by .gitignore rules are excluded (like ripgrep's .gitignore handling). " +
      'Use this to find references, patterns, or specific code in the workspace. ' +
      'Use `path` to scope the search to a directory or file. ' +
      'Use `glob` to filter by file extension (e.g. "*.ts", "*.{ts,tsx}"). ' +
      'Prefer search_content over shell_execute with grep/rg/ag: it applies .gitignore rules and returns structured, truncated results.',
    commonMistakes:
      'Using shell_execute(grep/rg) instead of search_content. ' +
      'Using shell_execute(find/ls) instead of search_files. ' +
      'Searching too broadly without a glob filter — wastes context. ' +
      'Not reading the matched files after finding them — search is discovery, not understanding.',
    outputFormat:
      'JSON: ok (boolean), command (executed), stdout (matching lines with file:line:content), stderr. ' +
      'No matches return ok: true with empty stdout — this is normal, not an error.',
    failureHandling:
      'Empty stdout with ok: true: no matches. Narrow path or adjust pattern and glob. ' +
      'ok: false with stderr: invalid regex pattern or nonexistent path — fix the pattern or check the path. ' +
      'Expected file missing from results: it may be excluded by .gitignore — use read_file with the exact path to read it anyway. ' +
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
      "Files and directories ignored by .gitignore rules are excluded (like ripgrep's .gitignore handling). " +
      'Use this to locate specific files by glob pattern (e.g. "*.test.ts", "**/config.*"). ' +
      'Pattern MUST include a file extension or name fragment — do NOT use bare "*" to dump the entire file tree. ' +
      'Use `path` to scope the search to a directory. ' +
      'Prefer search_files over shell_execute with find/ls: it applies .gitignore rules and returns structured, truncated results.',
    commonMistakes:
      'Using bare "*" pattern — too broad, returns every file. Use "*.ts" or "*.test.*" instead. ' +
      'Using shell_execute(find/ls) instead of search_files. ' +
      'Using search_files to read file contents — use read_file for that. ' +
      'Pattern without wildcards — search_files is for discovery, use read_file for known paths.',
    outputFormat:
      'JSON: ok (boolean), command (executed), stdout (file paths, one per line, sorted), stderr. ' +
      'No matches return ok: true with empty stdout.',
    failureHandling:
      'No files found: retry with broader pattern or different directory. ' +
      'ok: false with stderr: nonexistent path — check the path argument. ' +
      'Expected file missing: it may be excluded by .gitignore — use read_file with the exact path to access it anyway. ' +
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
      'Prefer search_content and search_files over `grep`, `rg`, `find`, and `ls` — they apply .gitignore rules and return structured results; shell_execute remains available when you need shell-specific behavior. ' +
      'Do NOT use shell_execute for: searching file contents (use search_content), finding files (use search_files), reading files (use read_file), editing files (use edit_file), writing files (use write_file). ' +
      'Use shell_execute ONLY for: tests, typecheck, builds, installs, git operations, and other terminal-only tasks. ' +
      'Commands have a default hard timeout of 600000ms. For commands that start a TUI, dev server, watcher, or other long-running process, set a shorter timeout_ms (for example 10000) so the command returns after collecting startup output. ' +
      'Set a longer timeout_ms only when a finite build, install, or test suite is expected to need more than 10 minutes. ' +
      'Write a short human-readable description so the user understands what the command does.',
    commonMistakes:
      'Reaching for shell_execute with grep/rg/find when search_content/search_files would give structured, .gitignore-aware results. ' +
      'Missing description field — always provide a short human-readable summary. ' +
      'Relying on the 600000ms default for interactive or long-running commands like `npm run tui`, `bun run dev`, or watch mode instead of setting a short startup timeout_ms. ' +
      'Running destructive commands (rm -rf, git reset --hard, curl | sh, chmod -R) — denied by default.',
    outputFormat:
      'JSON with fields: ok (boolean), command (executed command), exitCode (0=success), stdout, stderr. ' +
      'If rejected by policy, ok: false with reason in stderr. ' +
      'Check stderr for warnings even when exitCode is 0.',
    failureHandling:
      'If exitCode nonzero: read stderr, adjust command, retry. ' +
      'rg (ripgrep) exit code 1 means NO matches found — this is NOT an error, do not retry. ' +
      'grep exit code 1 likewise means no matches. ' +
      'If tests fail: read failure output, fix code, re-run. ' +
      'If rejected by policy: explain why the command is needed and wait for the user approval flow. ' +
      'If output empty but exitCode 0: try different flags or path.',
  },
  description: '',
};
SHELL_EXECUTE_CONTRACT.description = buildDescription(SHELL_EXECUTE_CONTRACT.sections);

export const UPDATE_PLAN_CONTRACT: ToolContract = {
  name: 'update_plan',
  sections: {
    whenToUse:
      'After plan approval (executing phase), update step execution status. ' +
      'Use this to mark steps as in_progress when you begin work, completed when finished, or skipped when unnecessary. ' +
      'Set complete_plan: true when all steps are done to mark the entire plan as completed. ' +
      "Do NOT use update_plan to modify plan structure (steps, title, description) — that is write_plan's job. " +
      'Do NOT call update_plan before plan approval — it will be rejected in planning phase. ' +
      'update_plan is for progress tracking only, not for structural changes.',
    outputFormat:
      'JSON: { ok: true, plan_id, updated_steps, plan_completed }.\n' +
      '- updates: array of { step_id, status (pending|in_progress|completed|skipped), note? }\n' +
      '- complete_plan: optional boolean, set to true when all work is done',
    commonMistakes:
      'Calling update_plan before the plan is approved — rejected in planning phase, wait for approval. ' +
      'Trying to modify step titles or add new steps via update_plan — use write_plan for structural changes instead. ' +
      'Not using stable step IDs from the original plan document — wrong IDs cause errors. ' +
      'Calling update_plan with a step_id that does not exist — the call will fail with a mismatch error. ' +
      'Forgetting to set complete_plan when all steps are done — the plan stays in_progress.',
    failureHandling:
      'Rejected in planning phase — wait for plan approval first. ' +
      'Invalid step_id: verify the step IDs match those in the approved plan. ' +
      'Structural changes rejected: use write_plan to save a revised draft, then submit for re-approval.',
  },
  description: '',
};
UPDATE_PLAN_CONTRACT.description = buildDescription(UPDATE_PLAN_CONTRACT.sections);

export const WRITE_PLAN_CONTRACT: ToolContract = {
  name: 'write_plan',
  sections: {
    whenToUse:
      'Save or submit the current plan Artifact. Use action="save" once the complete draft is ready; this writes an immutable user-level Markdown Artifact and returns only its metadata. ' +
      'Then call action="submit" with plan_id, version, and structural_digest from save; submit reads the Artifact and pauses for user review without creating another version. ' +
      'A revision creates the next version with save, then submits that version. ' +
      'After approval, switch to update_plan for step-level progress tracking. ' +
      'save requires a clear title (one line, max 120 chars), detailed body_markdown, and structured steps (1-12 items, each with stable id and one-line title). ' +
      'Use this in planning phase. While an approved plan is executing, save a revised Artifact and submit it for structural replan review.',
    outputFormat:
      'action="save": { ok: true, status: "draft_saved", task_id, plan_id, version, artifact: { artifact_id, path, structural_digest, byte_length }, next_action: "submit" }.\n' +
      'action="submit" on approval: { ok: true, status: "approved", plan_id, version, execution_mode }.\n' +
      'action="submit" on revision: { ok: false, status: "revision_requested", feedback, plan_id, version }.\n' +
      '- plan_id: stable identifier across versions\n' +
      '- version: incremented only when save creates a new Artifact\n' +
      '- structural_digest: SHA-256 of plan structure (title, body, step ids+titles)\n' +
      '- submit does not return the full plan body and does not increment version',
    commonMistakes:
      'Calling save repeatedly instead of submitting the Artifact returned by the previous save. ' +
      'Using unstable step IDs that change across versions — use stable descriptive IDs like "inspect-runtime". ' +
      'Putting architecture details in step titles instead of body_markdown. ' +
      'Forgetting to pass the exact plan_id, version, and structural_digest returned by save to submit.',
    failureHandling:
      'Rejected after side effects have started unless this is a structural replan submitted for review. ' +
      'Version conflict: if expected_version does not match current version, the call is rejected — re-read current plan state. ' +
      'Schema validation: title max 120 chars, body_markdown min 20 chars, steps 1-12 items. ' +
      'Revision feedback: read the feedback, update your plan with action="save" or action="submit".',
  },
  description: '',
};
WRITE_PLAN_CONTRACT.description = buildDescription(WRITE_PLAN_CONTRACT.sections);

export const ASK_USER_CONTRACT: ToolContract = {
  name: 'ask_user',
  sections: {
    whenToUse:
      'Ask the user focused questions when progress is blocked by uncertainty only the user can resolve. ' +
      'Use the `questions` array to batch all unknowns into ONE call — ask everything at once rather than ' +
      'spreading clarifications across multiple interruptions. Each question gets its own options (max 3). ' +
      'Only use single-question mode (`question` + `options`) for simple choose-one scenarios. ' +
      'In plan mode: batch all pre-plan clarifications into one ask_user call before calling write_plan.',
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
      'ALWAYS use list_mcp_resources first to discover available URIs before calling read_mcp_resource. ' +
      'Do NOT use read_mcp_resource for tools or prompts — use the dedicated mcp__<server>__<tool> functions instead. ' +
      'Do NOT use read_mcp_resource for reading workspace files — use read_file instead. ' +
      'This tool only accesses content explicitly exposed by the MCP server; it cannot read arbitrary files.',
    commonMistakes:
      'Calling read_mcp_resource without first discovering available URIs via list_mcp_resources — the call will fail closed. ' +
      'Using a wrong server name — verify the server is connected via /mcp panel before calling. ' +
      'Assuming the MCP server exposes resources when it only has tools — check the MCP panel to confirm resources are available. ' +
      'Not handling the case where no MCP manager is available — calls fail gracefully with a clear message.',
    outputFormat:
      'JSON: ok (boolean), content (string — the resource text content), or stderr (string) on failure. ' +
      'Multiple resource parts are joined with newlines. ' +
      'No MCP manager: ok: false with stderr explaining configuration is needed.',
    failureHandling:
      "If 'Unknown MCP server': verify the server name in /mcp or <project>/.kite-code/mcp.json. " +
      "If 'MCP server not connected': check /mcp panel for connection status and errors. " +
      "If 'No MCP manager available': open /mcp to manage MCP providers. " +
      'Canonical config files are <project>/.kite-code/mcp.json and ~/.kite-code/mcp.json. ' +
      'If the resource content is unexpectedly empty: verify the URI with list_mcp_resources and try again.',
  },
  description: '',
};
READ_MCP_RESOURCE_CONTRACT.description = buildDescription(READ_MCP_RESOURCE_CONTRACT.sections);

export const LIST_MCP_RESOURCES_CONTRACT: ToolContract = {
  name: 'list_mcp_resources',
  sections: {
    whenToUse:
      'List static resources discovered from connected MCP servers before calling read_mcp_resource. ' +
      'Omit server to inspect all available providers, or provide an exact server name to narrow the result. ' +
      'Use tool_search for executable MCP tools; it does not list resources.',
    commonMistakes:
      'Do not invent a URI or treat a resource as an executable MCP tool. ' +
      'Avoid calling this tool repeatedly when the result is empty; the provider may expose tools but no resources.',
    outputFormat:
      'JSON: ok, resource_count, resources, truncated, and next_step. ' +
      'Each resource contains server, uri, name, and optional mime_type. Results are stable-sorted and limited to 100 entries.',
    failureHandling:
      'An unknown or unavailable server returns a structured error. ' +
      'If truncated is true, call again with an exact server to narrow the result.',
  },
  description: '',
};
LIST_MCP_RESOURCES_CONTRACT.description = buildDescription(LIST_MCP_RESOURCES_CONTRACT.sections);

export const LIST_MCP_TOOLS_CONTRACT: ToolContract = {
  name: 'list_mcp_tools',
  sections: {
    whenToUse:
      'List currently configured MCP providers and executable MCP tools. ' +
      'Use this when the user asks which MCP tools, servers, providers, ' +
      'or capabilities are currently available. ' +
      'Use tool_search instead when looking for a tool that can perform ' +
      'a specific action. Use list_mcp_resources only for static MCP resources.',
    commonMistakes:
      'Do not use list_mcp_resources to list executable tools. ' +
      'Do not treat an empty resource list as proof that no MCP tools exist. ' +
      'Do not treat a zero-match capability search as proof that the catalog is empty.',
    outputFormat:
      'JSON: configured_provider_count, callable_provider_count, ' +
      'available_tool_count, providers, tools, truncated, and optional next_cursor.',
    failureHandling:
      'If the cursor is stale, restart without a cursor. ' +
      'If a provider is unavailable, report its exact status and next_action. ' +
      'Do not claim a provider is unconfigured unless it is absent from the provider directory.',
  },
  description: '',
};
LIST_MCP_TOOLS_CONTRACT.description = buildDescription(LIST_MCP_TOOLS_CONTRACT.sections);

export const TOOL_SEARCH_CONTRACT: ToolContract = {
  name: 'tool_search',
  sections: {
    whenToUse:
      'Search the governed MCP and Skill catalog by intent when the Runtime has not disclosed a matching capability. ' +
      'Use search_content instead for workspace text and search_files for file names. ' +
      'This tool discovers metadata only; wait for the next model call before using a matching MCP tool or activate_skill. ' +
      'Search once per intent or per provider — do not issue separate searches for individual tools from the same provider. ' +
      'Use short action-oriented queries ("create GitHub issue", "query docs") rather than tool names or verbose descriptions.',
    commonMistakes:
      'Treating a candidate as authorization or trying to invoke its candidate_ref directly will fail. ' +
      'Issuing multiple searches for different tools from the SAME provider — search once with the provider name instead. ' +
      'Using tool_search to discover tool PARAMETERS or schemas — it only returns names and kinds; ' +
      'schemas are loaded automatically by the Runtime on the next model call. ' +
      'Do not guess a hidden capability ID, request schemas, or substitute tool_search for search_content. ' +
      'Avoid vague one-word queries that lack the action and target needed for deterministic recall.',
    outputFormat:
      'JSON: ok, search_id, candidate_count, candidates, and next_step. ' +
      'Each candidate contains candidate_ref, kind, name, provider_type, and provider; it never contains schemas or executable IDs.',
    failureHandling:
      'If no candidates match, refine the query with the intended action and target, then retry tool_search. ' +
      'If search is unavailable or the catalog revision changes, do not guess or call an old MCP name; search again on a supported model turn.',
  },
  description: '',
};
TOOL_SEARCH_CONTRACT.description = buildDescription(TOOL_SEARCH_CONTRACT.sections);

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
      'On error: ok: false with error field containing the error message. ' +
      'If blocked.reasonCode is SUBAGENT_TOOL_REQUIRES_APPROVAL, the harness will route approval and resume the same sub-agent context.',
    failureHandling:
      'If the sub-agent times out (30 min): the task returns an error. Retry with a more focused task description. ' +
      'If the sub-agent returns blocked.reasonCode=SUBAGENT_TOOL_REQUIRES_APPROVAL: do not retry task and do not run the blocked tool yourself; wait for the harness to resume it. ' +
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
      'JSON: ok (boolean), url (requested URL), finalUrl (after redirects), ' +
      'title (extracted page title, HTML only), content (Markdown for HTML, raw text for JSON/XML/CSV/plain), ' +
      'contentType (MIME type), truncated (boolean). ' +
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
  'read_plan',
  'edit_file',
  'write_file',
  'shell_execute',
  'search_content',
  'search_files',
  'tool_search',
  'activate_skill',
  'complete_skill',
  'read_skill_reference',
  'list_mcp_resources',
  'list_mcp_tools',
  'read_mcp_resource',
  'write_plan',
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
  ['read_plan', READ_PLAN_CONTRACT],
  ['edit_file', EDIT_FILE_CONTRACT],
  ['write_file', WRITE_FILE_CONTRACT],
  ['shell_execute', SHELL_EXECUTE_CONTRACT],
  ['search_content', SEARCH_CONTENT_CONTRACT],
  ['search_files', SEARCH_FILES_CONTRACT],
  ['tool_search', TOOL_SEARCH_CONTRACT],
  ['list_mcp_resources', LIST_MCP_RESOURCES_CONTRACT],
  ['list_mcp_tools', LIST_MCP_TOOLS_CONTRACT],
  ['read_mcp_resource', READ_MCP_RESOURCE_CONTRACT],
  ['write_plan', WRITE_PLAN_CONTRACT],
  ['update_plan', UPDATE_PLAN_CONTRACT],
  ['ask_user', ASK_USER_CONTRACT],
  ['task', TASK_CONTRACT],
  ['web_fetch', WEB_FETCH_CONTRACT],
]);
