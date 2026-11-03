const annotationCss = '#__agent_browser_annotations__{display:none!important}';

export interface BrowserAnnotationStylePort {
  insertCSS(css: string, options: { cssOrigin: 'user' }): Promise<string>;
  removeInsertedCSS(key: string): Promise<void>;
}

/** Owns only the fixed annotation CSS key, including insertions that finish after revocation. */
export function createBrowserAnnotationStyle(port: BrowserAnnotationStylePort) {
  let revision = 0;
  let requested: number | undefined;
  let installed: { key: string } | undefined;
  let current: { revision: number; promise: Promise<void> } | undefined;
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (operation: () => Promise<void>) => {
    const result = tail.then(operation);
    // A failed removal retains its exact key. A later clear may retry it, but the
    // original caller still receives the failure and cannot report a clean handoff.
    tail = result.catch(() => {});
    return result;
  };
  const remove = async () => {
    if (!installed) return;
    const value = installed;
    await port.removeInsertedCSS(value.key);
    if (installed === value) installed = undefined;
  };

  return {
    ensure(navigation: number) {
      if (!Number.isSafeInteger(navigation) || navigation < 0)
        return Promise.reject(Error('browser_annotation_navigation_invalid'));
      if (requested === navigation && current?.revision === revision) return current.promise;
      requested = navigation;
      const expected = ++revision;
      const valid = () => revision === expected && requested === navigation;
      const promise = enqueue(async () => {
        if (!valid()) throw Error('browser_annotation_style_stale');
        await remove();
        if (!valid()) throw Error('browser_annotation_style_stale');
        const key = await port.insertCSS(annotationCss, { cssOrigin: 'user' });
        installed = { key };
        // clear()/a new navigation already queued the removal. Preserve the late
        // key for that operation instead of losing it with the obsolete caller.
        if (!valid()) throw Error('browser_annotation_style_stale');
      });
      current = { revision: expected, promise };
      return promise;
    },
    clear() {
      ++revision;
      requested = undefined;
      current = undefined;
      return enqueue(remove);
    },
  };
}
