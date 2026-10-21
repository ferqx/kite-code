/** Convert only a path obtained from Electron's actual disk-backed File object. No I/O. */
export function inputFileReference(name: string, path: string) {
  if (!name || name.length > 512 || !path || path.includes('\0'))
    throw Error('file_reference_unavailable');
  const uri = new URL('file:///');
  let pathname: string;
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    pathname = `/${path.replaceAll('\\', '/')}`;
  } else if (path.startsWith('\\\\')) {
    const parts = path.slice(2).split('\\');
    const host = parts.shift();
    if (!host || host === '?' || host === '.' || !parts[0])
      throw Error('file_reference_unavailable');
    uri.hostname = host;
    if (!uri.hostname) throw Error('file_reference_unavailable');
    pathname = `/${parts.join('/')}`;
  } else if (path.startsWith('/')) pathname = path;
  else throw Error('file_reference_unavailable');
  uri.pathname = pathname
    .split('/')
    .map(encodeURIComponent)
    .join('/')
    .replace(/^\/([A-Za-z])%3A\//, '/$1:/');
  if (uri.href.length > 8192) throw Error('file_reference_unavailable');
  return { name, uri: uri.href };
}
