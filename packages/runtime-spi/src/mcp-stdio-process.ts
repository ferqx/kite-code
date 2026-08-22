/** Neutral authenticated MCP stdio process seam. Host owns process mechanics. */
export interface McpStdioProcessPortV1 {
  spawn(input: McpStdioProcessLaunchV1): Promise<McpStdioProcessHandleV1>;
}

export interface McpStdioProcessLaunchV1 {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface McpStdioProcessHandleV1 {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly ready: Promise<McpStdioReadyProofV1>;
  readonly terminal: Promise<McpStdioTerminalProofV1>;
  readonly exited: Promise<number>;
  write(data: Uint8Array): Promise<void>;
  closeInput(): Promise<void>;
  cleanup(): Promise<McpStdioCleanupProofV1>;
}

export interface McpStdioReadyProofV1 {
  readonly invocationId: string;
  readonly keyId: string;
  readonly wrapperPid: number;
  readonly childPid: number;
  readonly processStartIdentity: string;
}

export interface McpStdioTerminalProofV1 extends McpStdioReadyProofV1 {
  readonly exitCode: number;
  readonly cleanup: 'confirmed';
}

export interface McpStdioCleanupProofV1 {
  readonly confirmedExited: boolean;
  readonly terminalReceived: boolean;
  readonly forced: boolean;
  readonly unconfirmedProcessCount: number;
}
