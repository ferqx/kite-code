export {};

const root = process.argv[2];
const key = process.argv[3];
const value = process.argv[4];
const startAt = Number(process.argv[5]);
if (!root || !key || !value || !Number.isSafeInteger(startAt)) {
  throw new Error('Expected preference root, key, value and synchronized start.');
}

process.env.KITE_CODE_HOME = root;
const preferences = await import('../../src/preferences');
const waitMs = startAt - Date.now();
if (waitMs > 0) await Bun.sleep(waitMs);
const saved =
  key === 'language'
    ? preferences.saveUserLanguage(value as 'system' | 'zh-CN' | 'en-US')
    : key === 'colorPreset'
      ? preferences.saveColorPreset(value)
      : false;
if (!saved) throw new Error('Preference mutation failed.');
