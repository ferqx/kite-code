import { runServiceProcess } from '@kite-ai/service/main';
import { configure } from './job-reconcile-host';

await runServiceProcess({ configure });
