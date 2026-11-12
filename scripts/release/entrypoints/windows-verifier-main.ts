import { basename } from 'node:path';
import { runWindowsNativeVerifierMain } from './windows-native-verifier';
import { runWindowsTerminalVerifierMain } from './windows-terminal-verifier';

// Standalone Bun reports import.meta.main=false. The installed image name selects the entry.
const name = basename(process.execPath);
if (name === 'terminal-verifier.exe') await runWindowsTerminalVerifierMain();
else if (name === 'native-verifier.exe') await runWindowsNativeVerifierMain();
else {
  console.error('windows_shared_verifier_invalid');
  process.exitCode = 1;
}
