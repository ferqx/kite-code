import { randomUUID } from 'node:crypto';
import type { Session, WebContents, WebFrameMain } from 'electron';

export const officePreviewScheme = 'kite-office-preview';
const scopeFilter = { urls: [`${officePreviewScheme}://*/*`] };

type Lease = {
  root: WebContents;
  rootFrame: WebFrameMain;
  url: string;
  treeId?: number;
  accepts(url: string): boolean;
  response(request: Request): Promise<Response>;
};

const sessions = new WeakMap<Session, Map<string, Lease>>();

function leasesFor(session: Session) {
  const registered = sessions.get(session);
  if (registered) return registered;
  const leases = new Map<string, Lease>();
  sessions.set(session, leases);
  session.webRequest.onBeforeRequest(scopeFilter, (details, complete) => {
    const lease = leases.get(new URL(details.url).host);
    const frame = details.frame;
    if (
      !lease ||
      details.method !== 'GET' ||
      details.webContentsId !== lease.root.id ||
      frame?.parent !== lease.rootFrame ||
      !lease.accepts(details.url)
    ) {
      complete({ cancel: true });
      return;
    }
    if (
      details.resourceType === 'subFrame' &&
      details.url === lease.url &&
      lease.treeId === undefined
    ) {
      lease.treeId = frame.frameTreeNodeId;
      complete({ cancel: false });
      return;
    }
    complete({
      cancel:
        details.resourceType === 'subFrame' ||
        frame.frameTreeNodeId !== lease.treeId ||
        frame.url !== lease.url,
    });
  });
  session.protocol.handle(officePreviewScheme, (request) => {
    const lease = leases.get(new URL(request.url).host);
    return request.method === 'GET' && lease?.accepts(request.url)
      ? lease.response(request)
      : new Response(null, { status: 403 });
  });
  return leases;
}

/** Main installs only one opaque, direct child frame for each live preview. */
export function leaseOfficePreviewFrame(
  root: WebContents,
  origin: string,
  entry: string,
  accepts: Lease['accepts'],
  response: Lease['response'],
) {
  const leases = leasesFor(root.session);
  const url = `${origin}/${entry}`;
  const lease: Lease = { root, rootFrame: root.mainFrame, url, accepts, response };
  // Custom schemes have an opaque origin in Node's URL implementation.
  leases.set(new URL(origin).host, lease);
  const stopNavigation = (
    event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>,
  ) => {
    if (lease.treeId === undefined || event.isMainFrame) return;
    if (event.frame?.frameTreeNodeId === lease.treeId) event.preventDefault();
  };
  root.on('will-frame-navigate', stopNavigation);
  return {
    url,
    resolve() {
      const found = lease.rootFrame.frames.find((frame) => frame.frameTreeNodeId === lease.treeId);
      if (!found || found.url !== url || found.origin !== 'null' || found.isDestroyed())
        throw Error('preview_frame_unavailable');
      return found;
    },
    close() {
      leases.delete(new URL(origin).host);
      if (!root.isDestroyed()) root.off('will-frame-navigate', stopNavigation);
    },
  };
}

export function newOfficePreviewOrigin() {
  return `${officePreviewScheme}://${randomUUID()}`;
}

type FrameTree = {
  frame: { id: string; url: string };
  childFrames?: FrameTree[];
};

/** WebFrameMain evaluation uses the page world. Keep the controller in its own world. */
export function createOfficeFrameWorld(root: WebContents, url: string, onDetached: () => void) {
  const debuggerPort = root.debugger;
  let closed = false;
  let sessionId: string | undefined;
  let contextId: number;
  if (debuggerPort.isAttached()) throw Error('preview_frame_world_unavailable');
  debuggerPort.attach('1.3');
  debuggerPort.once('detach', onDetached);
  const onMessage = (_event: Electron.Event, method: string, params: { sessionId?: string }) => {
    if (method !== 'Target.detachedFromTarget' || !sessionId || params.sessionId !== sessionId)
      return;
    // Retire the Root attachment after Chromium finishes dispatching the child detach event.
    setImmediate(() => {
      if (!closed) onDetached();
    });
  };
  debuggerPort.on('message', onMessage);
  const close = () => {
    if (closed) return;
    closed = true;
    if (root.isDestroyed()) return;
    debuggerPort.off('detach', onDetached);
    debuggerPort.off('message', onMessage);
    if (debuggerPort.isAttached()) {
      try {
        debuggerPort.detach();
      } catch {
        // Chromium may already be retiring the target.
      }
    }
  };
  const initialize = async () => {
    const { frameTree } = (await debuggerPort.sendCommand('Page.getFrameTree')) as {
      frameTree: FrameTree;
    };
    let id = frameTree.childFrames?.find(({ frame }) => frame.url === url)?.frame.id;
    if (!id) {
      const { targetInfos } = (await debuggerPort.sendCommand('Target.getTargets')) as {
        targetInfos: Array<{ type: string; url: string; targetId: string; parentFrameId?: string }>;
      };
      const targets = targetInfos.filter(
        (target) =>
          target.type === 'iframe' &&
          target.url === url &&
          target.parentFrameId === frameTree.frame.id,
      );
      if (targets.length !== 1) throw Error('preview_frame_world_unavailable');
      id = targets[0]!.targetId;
      const target = await debuggerPort.sendCommand('Target.attachToTarget', {
        targetId: id,
        flatten: true,
      });
      sessionId = target.sessionId;
    }
    const world = await debuggerPort.sendCommand(
      'Page.createIsolatedWorld',
      { frameId: id, worldName: 'kite-office-preview' },
      sessionId,
    );
    if (closed || !Number.isSafeInteger(world.executionContextId))
      throw Error('preview_frame_world_unavailable');
    contextId = world.executionContextId;
  };
  return {
    initialize,
    close,
    async evaluate<T>(code: string): Promise<T> {
      if (closed) throw Error('preview_replaced');
      const result = await debuggerPort.sendCommand(
        'Runtime.evaluate',
        {
          expression: code,
          contextId,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );
      if (closed) throw Error('preview_replaced');
      if (result.exceptionDetails) throw Error('preview_frame_script_failed');
      return result.result.value as T;
    },
  };
}
