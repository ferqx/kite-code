import { spawn } from "node:child_process";

export interface SearchCodeInput {
  workspace: string;
  /** 搜索模式（rg 正则表达式语法）/ Search pattern (rg regex syntax) */
  pattern: string;
  /** 可选搜索路径（相对于 workspace）/ Optional search path (relative to workspace) */
  path?: string;
}

export interface SearchCodeMatch {
  file: string;
  line: number;
  content: string;
}

export interface SearchCodeResult {
  ok: boolean;
  matches: SearchCodeMatch[];
  error?: string;
}

/** 使用 rg --json 搜索代码，返回结构化结果 / Search code with rg --json, returning structured results */
export async function searchCode(input: SearchCodeInput): Promise<SearchCodeResult> {
  const args = [
    "--json",
    "--line-number",
    "--no-heading",
    "--", // 防止 pattern 以 - 开头 / Prevent pattern starting with -
    input.pattern,
  ];

  if (input.path) {
    args.splice(args.length - 1, 0, input.path);
  }

  try {
    return await runRg(input.workspace, args);
  } catch {
    // rg 未安装时回退到 grep -rn / Fallback to grep -rn when rg is not installed
    return grepFallback(input);
  }
}

/** 运行 rg --json 并解析输出 / Run rg --json and parse output */
function runRg(workspace: string, args: string[]): Promise<SearchCodeResult> {
  return new Promise((resolve) => {
    const proc = spawn("rg", args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (code === 0) {
        // 无匹配 / No matches
        if (!stdout.trim()) {
          resolve({ ok: true, matches: [] });
          return;
        }
      } else if (code === 1) {
        // rg exit 1 = no matches found
        resolve({ ok: true, matches: [] });
        return;
      } else if (code !== 0 && code !== null) {
        resolve({ ok: false, matches: [], error: stderr || `rg exited with code ${code}` });
        return;
      }

      // 解析 JSON 行 / Parse JSON lines
      const matches: SearchCodeMatch[] = [];
      for (const line of stdout.trim().split("\n")) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "match") {
            const file = entry.data.path?.text ?? entry.data?.path ?? "";
            const lineNum = entry.data.line_number ?? 0;
            const content = entry.data.lines?.text ?? entry.data?.lines ?? "";
            matches.push({ file, line: lineNum, content: content.trimEnd() });
          }
        } catch {
          // 跳过无法解析的行 / Skip unparseable lines
        }
      }

      // 去重（同文件同行只保留第一个）/ Deduplicate (same file+line keep first)
      const seen = new Set<string>();
      const unique: SearchCodeMatch[] = [];
      for (const m of matches) {
        const key = `${m.file}:${m.line}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(m);
        }
      }

      resolve({ ok: true, matches: unique });
    });

    proc.on("error", (err) => {
      resolve({ ok: false, matches: [], error: `rg not found: ${err.message}` });
    });
  });
}

/** grep -rn 回退 / grep -rn fallback */
function grepFallback(input: SearchCodeInput): Promise<SearchCodeResult> {
  return new Promise((resolve) => {
    const searchPath = input.path ?? ".";
    const proc = spawn(
      "grep",
      ["-rn", "--", input.pattern, searchPath],
      { cwd: input.workspace, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      // grep exit 1 = no matches
      if (code === 1) {
        resolve({ ok: true, matches: [] });
        return;
      }

      if (code !== 0 && code !== null) {
        resolve({ ok: false, matches: [], error: stderr || `grep exited with code ${code}` });
        return;
      }

      // 解析 grep -rn 输出: file:line:content / Parse grep -rn output: file:line:content
      const matches: SearchCodeMatch[] = [];
      for (const line of stdout.trim().split("\n")) {
        if (!line) continue;
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const secondColon = line.indexOf(":", colonIdx + 1);
        if (secondColon === -1) continue;

        const file = line.slice(0, colonIdx);
        const lineNum = parseInt(line.slice(colonIdx + 1, secondColon), 10);
        const content = line.slice(secondColon + 1);
        if (!isNaN(lineNum)) {
          matches.push({ file, line: lineNum, content: content.trimEnd() });
        }
      }

      resolve({ ok: true, matches });
    });

    proc.on("error", (err) => {
      resolve({ ok: false, matches: [], error: `grep not found: ${err.message}` });
    });
  });
}
