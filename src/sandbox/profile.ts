/** 生成 macOS Seatbelt 沙箱 profile / Generate macOS Seatbelt sandbox profile */
export function generateSandboxProfile(workspace: string): string {
  return `(version 1)
(import "system.sb")
(deny default)

;; ── 进程执行 ──
(allow process-exec)
(allow process-fork)

;; ── 目录遍历：允许解析路径到任意位置（不影响文件数据读取） ──
(allow file-read-metadata (subpath "/"))

;; ── 工作目录：完整读写 ──
(allow file-read* file-write* file-ioctl (subpath "${esc(workspace)}"))

;; ── 临时目录：完整读写 ──
(allow file-read* file-write* file-ioctl
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "/private/var/tmp")
  (subpath "/private/var/folders"))

;; ── Shell 初始化路径（system.sb 不包含） ──
(allow file-read*
  (subpath "/etc")
  (subpath "/private/etc")
  (subpath "/private/var/select"))

;; ── 默认断网 ──
(deny network*)
`;
}

/** 转义 SBPL 字符串字面量中的反斜杠 / Escape backslashes in SBPL string literals */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\");
}
