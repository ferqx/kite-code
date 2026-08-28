import { describe, expect, test } from 'bun:test';
import * as rootContract from '../src/index';
import {
  WORKER_CONTROLLER_RECEIPT_SCHEMA_,
  WORKER_CONTROLLER_REQUEST_SCHEMA_,
  WORKER_CONTROLLER_RESPONSE_SCHEMA_,
  workerControllerRequestCodec,
  workerControllerResponseCodec,
} from '../src/worker-controller';

const digest = 'a'.repeat(64);
const secret = 'A'.repeat(43);

describe('native-only Worker Controller contract', () => {
  test('is not exported from the browser-safe root', () => {
    expect(Object.hasOwn(rootContract, 'workerControllerRequestCodec')).toBe(false);
    expect(Object.hasOwn(rootContract, 'WorkerControllerClient')).toBe(false);
  });

  test('round-trips request-control without client, connection, or Worker fields', () => {
    const request = {
      schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
      operation: 'request_control' as const,
      sessionId: 'session-1',
      requestId: 'request-1',
      requestDigest: digest,
      resumeSecret: secret,
      resumeExpiresAtMs: 10_000,
    };
    expect(
      workerControllerRequestCodec.decode(workerControllerRequestCodec.encode(request)),
    ).toEqual(request);
    expect(() =>
      workerControllerRequestCodec.decode({
        ...request,
        clientId: 'client-1',
      }),
    ).toThrow();
    expect(() =>
      workerControllerRequestCodec.decode({
        ...request,
        connectionGeneration: 1,
      }),
    ).toThrow();
    expect(() =>
      workerControllerRequestCodec.decode({
        ...request,
        workerInstanceId: 'worker-1',
      }),
    ).toThrow();
  });

  test('round-trips the closed atomic create-session request and rejects identity fields', () => {
    const request = {
      schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
      operation: 'create_session' as const,
      sessionId: 'session-created',
      requestId: 'create-request-1',
      requestDigest: digest,
      resumeSecret: secret,
      resumeExpiresAtMs: 10_000,
    };
    expect(
      workerControllerRequestCodec.decode(workerControllerRequestCodec.encode(request)),
    ).toEqual(request);
    for (const field of ['clientId', 'connectionGeneration', 'workerInstanceId', 'endpoint']) {
      expect(() =>
        workerControllerRequestCodec.decode({
          ...request,
          [field]: field === 'connectionGeneration' ? 1 : 'native-value',
        }),
      ).toThrow();
    }
    expect(() =>
      workerControllerRequestCodec.decode({
        ...request,
        command: { type: 'create_session' },
      }),
    ).toThrow();
  });

  test('enforces operation-specific exact keys and bounded secret/digest values', () => {
    const release = {
      schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
      operation: 'release_control' as const,
      sessionId: 'session-1',
      requestId: 'release-1',
      requestDigest: digest,
      controllerGeneration: 1,
    };
    expect(workerControllerRequestCodec.decode(release)).toEqual(release);
    expect(() =>
      workerControllerRequestCodec.decode({ ...release, resumeSecret: secret }),
    ).toThrow();
    expect(() =>
      workerControllerRequestCodec.decode({ ...release, requestDigest: 'bad' }),
    ).toThrow();
    expect(() =>
      workerControllerRequestCodec.decode({ ...release, controllerGeneration: -1 }),
    ).toThrow();
    expect(() =>
      workerControllerRequestCodec.decode({
        ...release,
        operation: 'request_control',
        resumeSecret: `${secret}x`,
        resumeExpiresAtMs: 10_000,
      }),
    ).toThrow();
  });

  test('covers detach, resume, and detached recovery requests as closed native operations', () => {
    const requests = [
      {
        schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
        operation: 'detach_controller' as const,
        sessionId: 'session-1',
        requestId: 'detach-1',
        requestDigest: digest,
        controllerGeneration: 1,
        interactionGeneration: 2,
      },
      {
        schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
        operation: 'resume_controller' as const,
        sessionId: 'session-1',
        requestId: 'resume-1',
        requestDigest: digest,
        controllerGeneration: 1,
        currentSecret: secret,
        nextSecret: `B${secret.slice(1)}`,
        expiresAtMs: 10_000,
      },
      {
        schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
        operation: 'mint_detached_recovery_capability' as const,
        sessionId: 'session-1',
        requestId: 'recovery-1',
        requestDigest: digest,
        expectedControllerGeneration: 1,
        expectedInteractionGeneration: 2,
        expiresAtMs: 10_000,
        connectionConfirmedAbsent: true,
        absenceEvidenceDigest: digest,
        secret,
      },
      {
        schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
        operation: 'abandon_detached_controller' as const,
        sessionId: 'session-1',
        requestId: 'abandon-1',
        requestDigest: digest,
        expectedControllerGeneration: 1,
        expectedInteractionGeneration: 2,
        connectionConfirmedAbsent: true,
        secret,
      },
    ];
    for (const request of requests) {
      expect(
        workerControllerRequestCodec.decode(workerControllerRequestCodec.encode(request)),
      ).toEqual(request);
    }
  });

  test('round-trips operation response and rejects receipt/request or Worker identity drift', () => {
    const response = {
      schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
      operation: 'request_control' as const,
      status: 'applied' as const,
      receipt: {
        schema: WORKER_CONTROLLER_RECEIPT_SCHEMA_,
        sessionId: 'session-1',
        requestId: 'request-1',
        requestDigest: digest,
        operation: 'request_control' as const,
        status: 'applied' as const,
        code: 'acquired' as const,
        controllerGeneration: 1,
        connectionGeneration: 7,
        interactionGeneration: 0,
        clientId: 'client-1',
        workerInstanceId: 'worker-1',
        completedAt: 10_000,
      },
      lease: {
        sessionId: 'session-1',
        clientId: 'client-1',
        connectionGeneration: 7,
        controllerGeneration: 1,
        workerInstanceId: 'worker-1',
        status: 'active' as const,
      },
    };
    expect(
      workerControllerResponseCodec.decode(workerControllerResponseCodec.encode(response)),
    ).toEqual(response);
    expect(() =>
      workerControllerResponseCodec.decode({
        ...response,
        receipt: { ...response.receipt, requestId: 'other-request' },
      }),
    ).not.toThrow();
    expect(() =>
      workerControllerResponseCodec.decode({
        ...response,
        receipt: { ...response.receipt, operation: 'release_control' },
      }),
    ).toThrow();
    expect(() =>
      workerControllerResponseCodec.decode({
        ...response,
        lease: { ...response.lease, workerInstanceId: 'other-worker' },
      }),
    ).not.toThrow();
  });

  test('round-trips atomic create response with a nonnegative session revision', () => {
    const response = {
      schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
      operation: 'create_session' as const,
      status: 'applied' as const,
      sessionRevision: 0,
      receipt: {
        schema: WORKER_CONTROLLER_RECEIPT_SCHEMA_,
        sessionId: 'session-created',
        requestId: 'create-request-1',
        requestDigest: digest,
        operation: 'request_control' as const,
        status: 'applied' as const,
        code: 'acquired' as const,
        controllerGeneration: 1,
        connectionGeneration: 7,
        interactionGeneration: 0,
        clientId: 'client-1',
        workerInstanceId: 'worker-1',
        completedAt: 10_000,
      },
      lease: {
        sessionId: 'session-created',
        clientId: 'client-1',
        connectionGeneration: 7,
        controllerGeneration: 1,
        workerInstanceId: 'worker-1',
        status: 'active' as const,
      },
    };
    expect(
      workerControllerResponseCodec.decode(workerControllerResponseCodec.encode(response)),
    ).toEqual(response);
    expect(() =>
      workerControllerResponseCodec.decode({
        ...response,
        sessionRevision: -1,
      }),
    ).toThrow();
    expect(() =>
      workerControllerResponseCodec.decode({
        ...response,
        endpoint: 'http://127.0.0.1:1234',
      }),
    ).toThrow();
    expect(() =>
      workerControllerResponseCodec.decode({
        ...response,
        receipt: { ...response.receipt, operation: 'create_session' },
      }),
    ).toThrow();
  });

  test('requires lease and session revision for applied and replay create results', () => {
    const receipt = {
      schema: WORKER_CONTROLLER_RECEIPT_SCHEMA_,
      sessionId: 'session-created',
      requestId: 'create-request-1',
      requestDigest: digest,
      operation: 'request_control' as const,
      status: 'applied' as const,
      code: 'acquired' as const,
      controllerGeneration: 1,
      connectionGeneration: 7,
      interactionGeneration: 0,
      clientId: 'client-1',
      workerInstanceId: 'worker-1',
      completedAt: 10_000,
    };
    const lease = {
      sessionId: 'session-created',
      clientId: 'client-1',
      connectionGeneration: 7,
      controllerGeneration: 1,
      workerInstanceId: 'worker-1',
      status: 'active' as const,
    };
    const base = {
      schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
      operation: 'create_session' as const,
      status: 'replay' as const,
      sessionRevision: 0,
      receipt,
      lease,
    };
    expect(workerControllerResponseCodec.decode(base)).toEqual(base);
    expect(() =>
      workerControllerResponseCodec.decode({ ...base, sessionRevision: undefined }),
    ).toThrow();
    expect(() => workerControllerResponseCodec.decode({ ...base, lease: undefined })).toThrow();
  });

  test('supports read and resume validation responses without exposing secrets', () => {
    const state = {
      sessionId: 'session-1',
      status: 'idle' as const,
      controllerGeneration: 2,
      connectionGeneration: 1,
      clientId: null,
      workerInstanceId: null,
      interactionGeneration: 0,
      resumeCapabilityExpiresAtMs: null,
    };
    const read = {
      schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
      operation: 'read_controller' as const,
      state,
    };
    expect(
      workerControllerResponseCodec.decode(workerControllerResponseCodec.encode(read)),
    ).toEqual(read);
    const validation = {
      schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
      operation: 'validate_resume_capability' as const,
      status: 'valid' as const,
      connectionGeneration: 4,
    };
    expect(
      workerControllerResponseCodec.decode(workerControllerResponseCodec.encode(validation)),
    ).toEqual(validation);
    expect(() => workerControllerResponseCodec.decode({ ...validation, secret })).toThrow();
  });
});
