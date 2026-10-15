import { runSpecialFixture } from './new-service-fixture';
import { installOriginalDeliveryRace } from './new-service-races';

const restore = installOriginalDeliveryRace(process.env.KITE_TUI_FIXTURE_DELIVERY_MODE ?? 'normal');
try {
  await runSpecialFixture('presentation-race');
} finally {
  restore();
}
