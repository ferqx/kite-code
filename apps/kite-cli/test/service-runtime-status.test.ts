import { describe, expect, test } from 'bun:test';
import { formatAppServerRuntimeStatus } from '../src/tui/service-runtime-status';

describe('TUI App Server status presentation', () => {
  test('shows parent-owned App Server pairing without a PID or Web endpoint', () => {
    const status = formatAppServerRuntimeStatus(
      {
        transport: 'stdio',
        mode: 'source',
        buildId: 'dev:paired',
        serverVersion: 'kite-app-server-v1-paired',
        clientVersion: '0.1.0',
        pairing: 'same_build',
      },
      {
        transport: 'App Server transport',
        mode: 'Runtime profile',
        buildId: 'Build',
        serverVersion: 'App Server version',
        clientVersion: 'Client version',
        paired: 'Client and App Server are exactly paired',
        protocolCompatible: 'Client and daemon use the exact compatible protocol',
      },
    );
    expect(status).toContain('App Server transport: stdio');
    expect(status).toContain('Runtime profile: source');
    expect(status).toContain('Client and App Server are exactly paired');
    expect(status).not.toContain('PID');
    expect(status).not.toContain('Web');
  });

  test('describes explicit daemon compatibility without claiming same-build pairing', () => {
    const status = formatAppServerRuntimeStatus(
      {
        transport: 'unix',
        mode: 'installed',
        buildId: 'daemon-build',
        serverVersion: 'kite-app-server-daemon-v1',
        clientVersion: 'newer-client',
        pairing: 'exact_protocol',
      },
      {
        transport: 'Transport',
        mode: 'Profile',
        buildId: 'Build',
        serverVersion: 'Server',
        clientVersion: 'Client',
        paired: 'same build',
        protocolCompatible: 'exact protocol compatible',
      },
    );
    expect(status).toContain('exact protocol compatible');
    expect(status).not.toContain('same build');
  });
});
