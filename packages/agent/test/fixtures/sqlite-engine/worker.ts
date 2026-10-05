import { assertSelectedSqliteEngine } from '../../../src/sqlite-engine';

self.onmessage = (event) => {
  self.postMessage(assertSelectedSqliteEngine(event.data));
};
