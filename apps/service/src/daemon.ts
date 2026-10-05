/** Private native launcher surface. Business and lifecycle requests still use the HTTP Client. */
export { bootstrapSchema, type DaemonBootstrap } from './daemon/bootstrap';
export {
  clearDeadDaemonEndpoint,
  type DaemonEndpoint,
  type DaemonProfile,
  type DaemonReservation,
  readDaemonReservation,
  requestDaemonBootstrap,
  selectDaemonEndpoint,
} from './daemon/endpoint';
export { inspectProcess } from './daemon/process-identity';
export { type DaemonWebSelection, loadDaemonWebAssets } from './daemon/web-assets';
export { type DaemonStartup, daemonPreflightSchema, daemonStartupSchema } from './daemon-startup';
