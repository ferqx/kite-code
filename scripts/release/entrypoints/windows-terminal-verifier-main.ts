import { runWindowsTerminalVerifierMain } from './windows-terminal-verifier';

// Standalone Bun 1.4.2 reports import.meta.main=false. This is the fixed executable entry.
await runWindowsTerminalVerifierMain();
