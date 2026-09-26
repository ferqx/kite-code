import { test } from 'bun:test';
import { exerciseChildOrchestration } from './child-session-orchestrator-integration-fixture';

test(
  'direct child orchestrator uses real Store and Host authority through terminal import',
  () => exerciseChildOrchestration(false),
  30_000,
);

test(
  'fresh orchestrator recovers an accepted intent once and second sweep is idempotent',
  () => exerciseChildOrchestration(true),
  30_000,
);

test(
  'recovery completion reports a child work queue failure without dispatching Provider',
  () => exerciseChildOrchestration(true, false, false, false, false, false, false, true),
  30_000,
);

test(
  'fenced child attempt seals unknown and settles the parent claim without replaying Provider',
  () => exerciseChildOrchestration(false, true),
  30_000,
);

test(
  'durable stop after an external attempt settles unknown without Provider replay',
  () => exerciseChildOrchestration(false, true, false, false, false, false, true),
  30_000,
);

test(
  'parent cancellation stops one child and settles its required claim',
  () => exerciseChildOrchestration(false, false, true),
  30_000,
);

test(
  'task_cancel stops the exact locally owned child and returns its settled status',
  () => exerciseChildOrchestration(false, false, false, true),
  30_000,
);

test(
  'durable pre-dispatch stop settles the parent claim without creating a child Session',
  () => exerciseChildOrchestration(false, false, false, false, true),
  30_000,
);

test(
  'durable stop after ACK seals a clean cancellation without Provider dispatch',
  () => exerciseChildOrchestration(false, false, false, false, false, true),
  30_000,
);
