import { main } from '@/app/cli';
import packageJson from '../../../package.json' with { type: 'json' };

if (process.argv.includes('--version')) {
  console.log(`Kite Code ${packageJson.version}`);
} else {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
