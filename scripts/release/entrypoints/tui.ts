import { runTui } from '@/app/tui';
import packageJson from '../../../package.json' with { type: 'json' };

if (process.argv.includes('--version')) {
  console.log(`Kite Code TUI ${packageJson.version}`);
} else {
  runTui();
}
