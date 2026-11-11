/** Explicitly configured model entry. No credentials discovery and no fixture mode. */
import { readFileSync } from 'node:fs';
import { parseLaunchArguments, runKiteTask } from './runtime';

const args = parseLaunchArguments(process.argv.slice(2));
// This file must be deliberately provisioned in the isolated image/container.
// It is not copied from any host home, environment key, or account profile.
const configuration = JSON.parse(readFileSync('/opt/kite-harbor/config.json', 'utf8'));
const report = await runKiteTask(args, { configuration, classification: 'configured-model-run' });
console.log(JSON.stringify(report));
process.exitCode = report.status === 'succeeded' ? 0 : report.status === 'cancelled' ? 130 : 2;
