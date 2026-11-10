import { createTrajectoryBundle, openTrajectoryBundle } from '@kite-ai/client';
import {
  type TrajectoryEvent,
  type TrajectoryEvidenceDescriptor,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { createRoot } from 'react-dom/client';
import type {
  NativeTrajectoryFileBridge,
  NativeTrajectoryFileRequest,
} from '../src/native-trajectory-file-bridge';
import { OfflineTrajectoryViewer } from '../src/native-trajectory-offline';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

// Explicit isolated artifact: the production cold viewer accepts only Main's local file port.
const integrity = {
  facts: 'complete' as const,
  identityConfidence: 'verified_origin' as const,
  reasons: [],
};
const snapshot = {
  storeId: 'offline-store',
  sessionId: 'offline-session',
  upperCursor: '610',
  formatVersion: 1 as const,
  historyCoverage: {
    enabledAfterCursor: '0',
    upperCursor: '610',
    status: 'retained' as const,
    integrity,
  },
};
const facts: TrajectoryEvent[] = Array.from({ length: 610 }, (_, index) =>
  trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${(index + 1).toString(16).padStart(64, '0')}`,
    sequence: String(index + 1),
    origin: { storeId: 'offline-store', cursor: String(index + 1) },
    sessionId: 'offline-session',
    workspaceId: 'offline-workspace',
    sourceEventType: 'execution.state_changed',
    sourceRecordRevision: String(index + 1),
    kind: 'model',
    executionId: `execution-${Math.floor(index / 3)}`,
    attempt: 1,
    phase: index === 609 ? 'running' : index % 3 === 2 ? 'completed' : 'running',
    recordedStatus: index === 609 ? 'running' : index % 3 === 2 ? 'succeeded' : 'running',
    occurredAt: null,
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs:
      index === 609
        ? [
            {
              evidenceId: 'output-610',
              contentVersion: 'result-7',
              kind: 'model_output',
              mediaType: 'application/json',
              availability: 'partial',
            },
          ]
        : [],
  }),
);
const body = new TextEncoder().encode(
  JSON.stringify({
    content: `离线包位置 610 的已保存正文。\n${'不连接Service的Unicode前缀 👋\n'.repeat(6000)}`,
    reasoningContent: '默认收起的推理材料',
  }),
);
const frames = new Map<string, Uint8Array>();
for await (const frame of createTrajectoryBundle({
  snapshot,
  async readEvents(request) {
    const selected = facts.filter(
      (event) =>
        BigInt(event.sequence) > BigInt(request.afterCursor) &&
        BigInt(event.sequence) <= BigInt(request.upperCursor),
    );
    const events = selected.slice(0, request.limit ?? 200);
    const exhausted = events.length === selected.length;
    const { limit: _limit, ...pageScope } = request;
    return {
      ...pageScope,
      events,
      scannedThrough: exhausted ? request.upperCursor : events.at(-1)!.sequence,
      exhausted,
      integrity,
    };
  },
  async readEvidence() {
    return body;
  },
}))
  frames.set(frame.path, frame.bytes);
const local = await openTrajectoryBundle({
  async list() {
    return [...frames.keys()];
  },
  async read(path, _signal, max) {
    const bytes = frames.get(path)!;
    if (max !== undefined && bytes.byteLength > max)
      throw Error('trajectory_bundle_budget_exceeded');
    return bytes;
  },
});
const hash = Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(body))),
  (byte) => byte.toString(16).padStart(2, '0'),
).join('');
const requests: NativeTrajectoryFileRequest[] = [];
const leases = new Map<string, TrajectoryEvidenceDescriptor>();
let serial = 0;
const files: NativeTrajectoryFileBridge = {
  async request(input) {
    requests.push(structuredClone(input));
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (input.method === 'pick')
      return {
        kind: 'trajectory.bundle.opened',
        bundleId: `bundle-${++serial}`,
        snapshot,
        minimumCursor: '0',
      };
    if (input.method === 'events')
      return { kind: 'trajectory.page', trajectory: await local.readEvents(input.request) };
    if (input.method === 'evidence.open') {
      if (input.request.eventId !== facts[609]!.eventId || BigInt(input.request.atCursor) < 610n)
        throw Error('trajectory_bundle_evidence_denied');
      const descriptor: TrajectoryEvidenceDescriptor = {
        readId: crypto.randomUUID(),
        eventId: input.request.eventId,
        evidenceId: 'output-610',
        contentVersion: 'result-7',
        availability: 'partial',
        mediaType: 'application/json',
        viewBytes: String(body.byteLength),
        viewSha256: hash,
        transformation: 'fixture.public@1',
        policyRevision: '1',
        authorizationEpoch: '1',
      };
      leases.set(descriptor.readId, descriptor);
      return { kind: 'trajectory.evidence.opened', trajectory: descriptor };
    }
    if (input.method === 'evidence.read') {
      const descriptor = leases.get(input.readId);
      if (!descriptor) throw Error('trajectory_bundle_read_missing');
      const start = Number(input.offset),
        end = Math.min(start + (input.limit ?? 65536), body.byteLength);
      let binary = '';
      for (const byte of body.subarray(start, end)) binary += String.fromCharCode(byte);
      return {
        kind: 'trajectory.evidence.chunk',
        trajectory: {
          readId: input.readId,
          offset: input.offset,
          nextOffset: String(end),
          data: btoa(binary),
          eof: end === body.byteLength,
          viewSha256: hash,

          policyRevision: '1',
          authorizationEpoch: '1',
        },
      };
    }
    if (input.method === 'evidence.close') {
      leases.delete(input.readId);
      return null;
    }
    if (input.method === 'close') {
      leases.clear();
      local.clearCache();
      return null;
    }
    throw Error('offline_export_unavailable');
  },
};
Object.assign(window, { trajectoryOfflineFixture: { requests, leases } });
const host = document.createElement('div');
host.style.height = '100vh';
document.body.append(host);
createRoot(host).render(<OfflineTrajectoryViewer files={files} />);
