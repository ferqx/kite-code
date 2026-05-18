/** 沙箱执行器配置 / Sandbox executor configuration */
export interface SandboxOptions {
  /** 启用沙箱；false 时回退到裸 shellTool / Enable sandbox; fall back to bare shellTool when false */
  enabled: boolean;
  /** 工作目录路径 / Workspace directory path */
  workspace: string;
  /** 自定义资源限制（覆盖默认值）/ Custom resource limits (overrides defaults) */
  resourceLimits?: Partial<ResourceLimits>;
}

/** shell 执行资源限制 / Shell execution resource limits */
export interface ResourceLimits {
  /** CPU 时间上限（秒）/ CPU time limit (seconds) */
  cpuTime: number;
  /** 虚拟内存上限（KB）/ Virtual memory limit (KB) */
  virtualMemory: number;
  /** 单文件写入大小上限（KB）/ File size limit (KB) */
  fileSize: number;
  /** 文件描述符上限 / File descriptor limit */
  fileDescriptors: number;
  /** 进程数上限 / Process count limit */
  processes: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  cpuTime: 120,
  virtualMemory: -1, // macOS 不支持；0/负值表示跳过 / not supported on macOS; skip
  fileSize: 1048576, // 512MB (macOS blocks = 512 bytes)
  fileDescriptors: 256,
  processes: -1, // sandbox 内不可靠 / unreliable inside sandbox; skip
};
