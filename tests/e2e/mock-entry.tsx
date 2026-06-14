/**
 * Mock TUI entry point for subprocess-based E2E testing.
 *
 * Spawned by tests/e2e/pty-harness.ts via:
 *   bun run tests/e2e/mock-entry.tsx
 *   OPENPX_MOCK_RESPONSES='["Reply 1","Reply 2"]'
 *
 * Completely separate from src/app/tui/index.tsx — zero mock code in src/.
 */
import React from "react";
import { render } from "ink";
import { TuiBootstrap } from "../../src/app/tui/index";
import ErrorBoundary from "../../src/app/tui/components/ErrorBoundary";
import { createMockModelFromEnv } from "../mock-agent";

const model = await createMockModelFromEnv();

const { unmount } = render(
  <ErrorBoundary><TuiBootstrap model={model} /></ErrorBoundary>,
  { maxFps: 60, exitOnCtrlC: false },
);

process.on("SIGINT", () => { unmount(); process.exit(0); });
process.on("SIGTERM", () => { unmount(); process.exit(0); });
