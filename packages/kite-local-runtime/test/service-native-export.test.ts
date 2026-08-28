import { describe, expect, test } from 'bun:test';
import {
  secureWindowsStatePath,
  verifyWindowsStatePath,
  windowsStateSecurityDiagnostic,
} from '@kite-ai/kite-local-runtime/service';

describe('native Service state security export', () => {
  test.skipIf(process.platform === 'win32')(
    'keeps the narrow Windows ACL seam inert on non-Windows hosts',
    () => {
      expect(secureWindowsStatePath('/not-opened', 'file')).toBeUndefined();
      expect(verifyWindowsStatePath('/not-opened', 'file')).toBeUndefined();
      expect(windowsStateSecurityDiagnostic(new Error('ordinary'))).toBeUndefined();
    },
  );
});
