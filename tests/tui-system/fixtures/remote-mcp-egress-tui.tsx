import { createRemoteMcpEgressPermitV1 } from '@kite/builtin-runtime/mcp';
import { runTui } from '@kite/kite/tui';

/**
 * Test-only composition root for scenarios whose subject needs an admitted
 * remote MCP content call. Production never imports this unconditional permit
 * issuer; scenarios must also enable the default-off policy flag explicitly.
 */
runTui({
  remoteMcpEgressPermitResolver: (request) =>
    createRemoteMcpEgressPermitV1({
      request,
      expiresAt: new Date(Date.now() + 60_000),
    }),
});
