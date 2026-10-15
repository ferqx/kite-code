import { runSpecialFixture } from './new-service-fixture';
import { installOriginalDeliveryRace } from './new-service-races';

const restore = installOriginalDeliveryRace('deferred-sandbox');
try {
  await runSpecialFixture('deferred-sandbox');
} finally {
  restore();
}
