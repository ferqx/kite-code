import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Test-owned entry only: ordinary development and installed argv have no diagnostics switch. */
const [entrypoint, ...argv] = process.argv.slice(2);
if (!entrypoint || !isAbsolute(entrypoint)) throw Error('tui_test_entrypoint_invalid');
const entry = await import(pathToFileURL(entrypoint).href);
if (typeof entry.runDevelopmentTUI === 'function')
  process.exitCode = await entry.runDevelopmentTUI({ argv, testDiagnostics: true });
else if (typeof entry.runInstalledTerminalTUI === 'function')
  process.exitCode = await entry.runInstalledTerminalTUI(argv, undefined, {
    testDiagnostics: true,
  });
else throw Error('tui_test_entrypoint_unsupported');
