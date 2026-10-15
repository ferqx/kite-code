import { runSpecialFixture } from './new-service-fixture';
import { installOriginalMcpSetup } from './new-service-mcp-setup';

const restore = installOriginalMcpSetup({ skipInitialSetup: true });
try {
  await runSpecialFixture('mcp-project');
} finally {
  restore();
}
