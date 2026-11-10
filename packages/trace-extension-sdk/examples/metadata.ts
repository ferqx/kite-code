import { acknowledge, defineTraceExtension } from '../src';

defineTraceExtension({
  async onEvents(batch, context) {
    await context.log.emit('delivery_started');
    // Replace with task/eventId-idempotent processing. ACK only after accepting responsibility.
    return acknowledge(batch.events);
  },
});
