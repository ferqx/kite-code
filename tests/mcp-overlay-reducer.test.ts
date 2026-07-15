import { describe, expect, test } from 'bun:test';
import { initialMcpOverlayState, mcpOverlayReducer } from '@/app/tui/mcp/reducer';

describe('MCP overlay reducer', () => {
  test('keeps search and selection local to the overlay', () => {
    let state = mcpOverlayReducer(initialMcpOverlayState, { type: 'start_search' });
    state = mcpOverlayReducer(state, { type: 'append_search', value: 'git' });
    state = mcpOverlayReducer(state, { type: 'move', delta: 1, count: 3 });
    expect(state).toMatchObject({ search: 'git', searchActive: true, selectedIndex: 1 });
  });

  test('backs out one route at a time', () => {
    let state = mcpOverlayReducer(initialMcpOverlayState, {
      type: 'open',
      route: 'detail',
      serverId: 'user:github',
    });
    state = mcpOverlayReducer(state, {
      type: 'open',
      route: 'tools',
      serverId: 'user:github',
    });
    state = mcpOverlayReducer(state, { type: 'back' });
    expect(state.route).toEqual({ kind: 'detail', serverId: 'user:github' });
    state = mcpOverlayReducer(state, { type: 'back' });
    expect(state.route).toEqual({ kind: 'list' });
  });
});
