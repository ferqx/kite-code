import { saveProviderConfig } from '../../src/config';

const configPath = process.argv[2];
const startAt = Number(process.argv[3]);
if (!configPath || !Number.isSafeInteger(startAt)) {
  throw new Error('Expected config path and synchronized start.');
}

const waitMs = startAt - Date.now();
if (waitMs > 0) await Bun.sleep(waitMs);
if (
  !saveProviderConfig(
    {
      name: 'fixture-provider',
      type: 'openai',
      baseURL: 'https://provider.example/v1',
      models: [{ name: 'fixture-model', default: true }],
    },
    configPath,
  )
) {
  throw new Error('Provider config mutation failed.');
}
