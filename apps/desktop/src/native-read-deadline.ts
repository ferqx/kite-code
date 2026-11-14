/** Bounds presentation reads. The owning reader still closes its scoped Main lease. */
export async function nativeReadDeadline<T>(read: Promise<T>, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('native_read_timeout')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
