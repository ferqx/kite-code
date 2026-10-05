import { runDaemonProcess } from '@kite-ai/service/daemon-main';
import { configure } from './job-reconcile-host';

await runDaemonProcess({ configure });
