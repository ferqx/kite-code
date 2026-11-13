import { parentPort } from 'node:worker_threads';
import { assertSelectedSqliteEngine } from '../../../src/sqlite-engine';

parentPort?.on('message', (selection) =>
  parentPort?.postMessage(assertSelectedSqliteEngine(selection)),
);
