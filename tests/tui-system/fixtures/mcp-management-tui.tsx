import { runSpecialFixture } from './new-service-fixture';
import { installOriginalMcpSetup } from './new-service-mcp-setup';

const restore = installOriginalMcpSetup();
try {
  await runSpecialFixture('mcp-management');
} finally {
  restore();
}
