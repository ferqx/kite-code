import { strict as assert } from 'node:assert';
import type { Page } from 'playwright';

/** Make the same explicit model choice as the ordinary Native user. */
export async function selectNativeFixtureModel(page: Page, name: string, id = name) {
  const trigger = page.locator('[data-model-picker] [data-model-trigger]');
  const modelName = async () => (await trigger.innerText()).trim().split('\n')[0];
  if ((await modelName()) === name) return;
  assert.equal(await modelName(), '选择模型');
  const send = page.getByRole('button', { name: '发送明确的新轮次', exact: true });
  if (await send.count()) assert.equal(await send.isDisabled(), true);
  await trigger.click();
  const popup = page.getByRole('dialog', { name: '模型与思考程度', exact: true });
  await popup.getByRole('button', { name: /^选择模型，当前/ }).click();
  await popup.getByRole('option', { name: `选择模型 ${id}`, exact: true }).click();
  await page.keyboard.press('Escape');
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await modelName(), name);
}
