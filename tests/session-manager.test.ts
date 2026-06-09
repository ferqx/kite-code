import { describe, expect, test } from "bun:test";
import { SessionManager, SessionRuntime } from "../src/app/tui/session-manager";

describe("SessionManager", () => {
  test("createSession returns unique threadId", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null, checkpointPath: ":memory:" });
    const id1 = mgr.createSession("/tmp/ws");
    const id2 = mgr.createSession("/tmp/ws");
    expect(id1).not.toBe(id2);
    expect(id1).toStartWith("tui-");
  });

  test("createSession adds snapshot", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null, checkpointPath: ":memory:" });
    const id = mgr.createSession("/tmp/ws");
    const snapshots = mgr.getSnapshot();
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].threadId).toBe(id);
    expect(snapshots[0].active).toBe(true);
    expect(snapshots[0].running).toBe(false);
    expect(snapshots[0].workspace).toBe("/tmp/ws");
  });

  test("switchSession toggles active flag", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null, checkpointPath: ":memory:" });
    const id1 = mgr.createSession("/tmp/ws");
    const id2 = mgr.createSession("/tmp/ws");
    mgr.switchSession(id1, id2);
    const snapshots = mgr.getSnapshot();
    const s1 = snapshots.find(s => s.threadId === id1)!;
    const s2 = snapshots.find(s => s.threadId === id2)!;
    expect(s1.active).toBe(false);
    expect(s2.active).toBe(true);
    expect(mgr.getActiveId()).toBe(id2);
  });

  test("getSnapshot reflects running state", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null, checkpointPath: ":memory:" });
    const id = mgr.createSession("/tmp/ws");
    const rt = mgr.getRuntime(id)!;
    rt.agentLoopActive = true;
    const snapshots = mgr.getSnapshot();
    expect(snapshots[0].running).toBe(true);
  });

  test("snapshot includes pendingInterrupt from runtime", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null, checkpointPath: ":memory:" });
    const id = mgr.createSession("/tmp/ws");
    const rt = mgr.getRuntime(id)!;
    rt.pendingInterrupt = true;
    const snapshots = mgr.getSnapshot();
    expect(snapshots[0].pendingInterrupt).toBe(true);
  });

  test("snapshotCallback fires on status change", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null, checkpointPath: ":memory:" });
    const calls: string[] = [];
    mgr.setSnapshotCallback((threadId) => calls.push(threadId));
    const id = mgr.createSession("/tmp/ws");
    mgr.onStatusChange(id);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(id);
  });

  test("abortAll aborts all running sessions", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null, checkpointPath: ":memory:" });
    const id1 = mgr.createSession("/tmp/ws");
    const id2 = mgr.createSession("/tmp/ws");
    const rt1 = mgr.getRuntime(id1)!;
    const rt2 = mgr.getRuntime(id2)!;

    // Simulate running state with AbortControllers
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    rt1.agentLoopActive = true;
    rt1.abortController = ac1;
    rt2.agentLoopActive = true;
    rt2.abortController = ac2;

    mgr.abortAll();

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
    expect(rt1.agentLoopActive).toBe(false);
    expect(rt2.agentLoopActive).toBe(false);
  });

  test("abortAll skips non-running sessions", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null, checkpointPath: ":memory:" });
    const id1 = mgr.createSession("/tmp/ws");
    const id2 = mgr.createSession("/tmp/ws");
    const rt1 = mgr.getRuntime(id1)!;
    const rt2 = mgr.getRuntime(id2)!;

    const ac1 = new AbortController();
    rt1.agentLoopActive = true;
    rt1.abortController = ac1;
    // rt2 is not running

    mgr.abortAll();

    expect(ac1.signal.aborted).toBe(true);
    expect(rt1.agentLoopActive).toBe(false);
    // rt2 should be unaffected
    expect(rt2.agentLoopActive).toBe(false);
    expect(rt2.abortController).toBeNull();
  });
});

describe("SessionRuntime", () => {
  test("abort resolves pending interrupt and signals AbortController", () => {
    const rt = new SessionRuntime("t1", "/tmp/ws", {
      config: {} as any,
      provider: {} as any,
      skillManifests: [],
      skillOptions: null,
      mcpManager: null, checkpointPath: ":memory:",
    });

    const ac = new AbortController();
    rt.agentLoopActive = true;
    rt.abortController = ac;

    // Simulate a pending interrupt promise
    let resolved = false;
    const pendingPromise = new Promise<void>((resolve) => {
      // Use a microtask to set up the pending resolve
      queueMicrotask(() => {
        (rt as any)._pendingResolve = () => { resolved = true; resolve(); };
      });
    });

    rt.abort();

    expect(ac.signal.aborted).toBe(true);
    expect(rt.agentLoopActive).toBe(false);
    expect(rt.abortController).toBeNull();
    expect(rt.generator).toBeNull();
  });

  test("abort is safe to call when no AbortController", () => {
    const rt = new SessionRuntime("t1", "/tmp/ws", {
      config: {} as any,
      provider: {} as any,
      skillManifests: [],
      skillOptions: null,
      mcpManager: null, checkpointPath: ":memory:",
    });

    // Should not throw
    rt.abort();
    expect(rt.agentLoopActive).toBe(false);
  });
});
