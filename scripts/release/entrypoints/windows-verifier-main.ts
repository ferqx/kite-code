import { basename } from 'node:path';
import { runWindowsNativeVerifierMain } from './windows-native-verifier';
import { runWindowsTerminalVerifierMain } from './windows-terminal-verifier';

// The same standalone verifier image serves both installed frontdoors by exact filename.
const name = basename(process.execPath);
if (name === 'terminal-verifier.exe') await runWindowsTerminalVerifierMain();
else if (name === 'native-verifier.exe') await runWindowsNativeVerifierMain();
else {
  console.error('windows_shared_verifier_invalid');
  process.exitCode = 1;
}
