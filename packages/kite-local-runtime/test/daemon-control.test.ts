import { expect, test } from 'bun:test';
import {
  KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_CODEC_,
  KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_SCHEMA_,
  KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_CODEC_,
  KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_SCHEMA_,
  KITE_APP_SERVER_DAEMON_STATUS_REQUEST_CODEC_,
  KITE_APP_SERVER_DAEMON_STATUS_REQUEST_SCHEMA_,
  KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_CODEC_,
  KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_SCHEMA_,
} from '../src/client';

test('App Server daemon lifecycle payloads are exact and path-bounded', () => {
  expect(
    KITE_APP_SERVER_DAEMON_STATUS_REQUEST_CODEC_.parse({
      schema: KITE_APP_SERVER_DAEMON_STATUS_REQUEST_SCHEMA_,
    }),
  ).toBeDefined();
  expect(
    KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_CODEC_.parse({
      schema: KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_SCHEMA_,
      state: 'ready',
      instanceId: 'daemon-1',
      buildId: 'build-1',
      startedAt: '2026-09-02T13:00:00.000Z',
      workspace: '/workspace',
    }),
  ).toBeDefined();
  expect(() =>
    KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_CODEC_.parse({
      schema: KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_SCHEMA_,
      state: 'ready',
      instanceId: 'daemon-1',
      buildId: 'build-1',
      startedAt: '2026-09-02T13:00:00.000Z',
      workspace: '/workspace',
      pid: 42,
    }),
  ).toThrow();
  expect(
    KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_CODEC_.parse({
      schema: KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_SCHEMA_,
    }),
  ).toBeDefined();
  expect(
    KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_CODEC_.parse({
      schema: KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_SCHEMA_,
      outcome: 'accepted',
    }),
  ).toBeDefined();
});
