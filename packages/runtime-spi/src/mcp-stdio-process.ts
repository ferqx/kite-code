/** Neutral authenticated MCP stdio process seam. Host owns process mechanics. */
export interface McpStdioProcessPort {
  spawn(input: McpStdioProcessLaunch): Promise<McpStdioProcessHandle>;
}

export interface McpStdioProcessLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface McpStdioProcessHandle {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly ready: Promise<McpStdioReadyProof>;
  readonly terminal: Promise<McpStdioTerminalProof>;
  readonly exited: Promise<number>;
  write(data: Uint8Array): Promise<void>;
  closeInput(): Promise<void>;
  cleanup(): Promise<McpStdioCleanupProof>;
}

export interface McpStdioReadyProof {
  readonly invocationId: string;
  readonly wrapperPid: number;
  readonly childPid: number;
  readonly processStartIdentity: string;
}

export interface McpStdioTerminalProof extends McpStdioReadyProof {
  readonly exitCode: number;
  readonly cleanup: 'confirmed';
}

export interface McpStdioCleanupProof {
  readonly confirmedExited: boolean;
  readonly terminalReceived: boolean;
  readonly forced: boolean;
  readonly unconfirmedProcessCount: number;
}
