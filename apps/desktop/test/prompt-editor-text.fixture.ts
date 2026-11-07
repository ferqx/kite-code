import type { Locator } from 'playwright';

/** Prompt input stays native text; no renderer or clipboard is needed to inspect it. */
export const promptText = (input: Locator): Promise<string> => input.inputValue();
