import { createFixedModel } from '@kite-ai/ai';
import { runServiceProcess } from '../../src/main';

await runServiceProcess({
  configure() {
    return { modelId: 'fixed', model: createFixedModel([]) };
  },
  async beforeResourceClose() {
    throw Error('fixture_gateway_cleanup_failed');
  },
});
