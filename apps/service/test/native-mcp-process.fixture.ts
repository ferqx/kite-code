import { mcpStdioGuardianAsset } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import type { ConfigureProcessHost } from '@kite-ai/service/bootstrap';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { runServiceProcess as runDefaultServiceProcess } from '@kite-ai/service/main';
import { runtimeProtectionRoots } from '@kite-ai/service/runtime-protection';

declare const __NATIVE_MCP_FIXTURE_CERTIFICATE__: string;
const certificate = __NATIVE_MCP_FIXTURE_CERTIFICATE__ || undefined;

/** Test candidate only: local peers, actual default browser/backend/permissions and packaged stdio. */
const configure: ConfigureProcessHost = (startup, context) =>
  createDefaultProcessConfiguration({
    profile: selectProfile(startup.profile),
    observerSubjectId: context.subjectId,
    hostConfiguration: startup.hostConfiguration,
    runtimeAssets: [
      process.argv[1]!,
      ...(startup.runtimeProtection ? runtimeProtectionRoots(startup.runtimeProtection) : []),
    ],
    mcpSources: {
      http: { allowLoopbackForTests: true, trustedTestCertificate: certificate },
      stdio: { guardianPath: mcpStdioGuardianAsset(), bunExecutable: process.execPath },
      oauth: {
        network: { allowLoopbackForTests: true, trustedTestCertificate: certificate },
      },
    },
  });
export function runServiceProcess(): Promise<void> {
  return runDefaultServiceProcess({ configure });
}
