import { describe, expect, test } from "bun:test";
import { SessionManager, SessionRuntime } from "../src/app/tui/session-manager";

describe("SessionManager", () => {
  test("createSession returns unique threadId", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null });
    const id1 = mgr.createSession("/tmp/ws");
    const id2 = mgr.createSession("/tmp/ws");
    expect(id1).not.toBe(id2);
    expect(id1).toStartWith("tui-");
  });

  test("createSession adds snapshot", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null });
    const id = mgr.createSession("/tmp/ws");
    const snapshots = mgr.getSnapshot();
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].threadId).toBe(id);
    expect(snapshots[0].active).toBe(true);
    expect(snapshots[0].running).toBe(false);
    expect(snapshots[0].workspace).toBe("/tmp/ws");
  });

  test("switchSession toggles active flag", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null });
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
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null });
    const id = mgr.createSession("/tmp/ws");
    const rt = mgr.getRuntime(id)!;
    rt.agentLoopActive = true;
    const snapshots = mgr.getSnapshot();
    expect(snapshots[0].running).toBe(true);
  });

  test("snapshot includes pendingInterrupt from runtime", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null });
    const id = mgr.createSession("/tmp/ws");
    const rt = mgr.getRuntime(id)!;
    rt.pendingInterrupt = true;
    const snapshots = mgr.getSnapshot();
    expect(snapshots[0].pendingInterrupt).toBe(true);
  });

  test("snapshotCallback fires on status change", () => {
    const mgr = new SessionManager({ config: {} as any, provider: {} as any, skillManifests: [], skillOptions: null, mcpManager: null });
    const calls: string[] = [];
    mgr.setSnapshotCallback((threadId) => calls.push(threadId));
    const id = mgr.createSession("/tmp/ws");
    mgr.onStatusChange(id);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(id);
  });
});
