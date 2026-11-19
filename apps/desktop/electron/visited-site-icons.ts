type Scope = { storeId: string; sessionId: string };
export function sourceIconOrigin(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.origin;
  } catch {}
  return undefined;
}
/** Only fixed 16×16 RGBA samples, never image locators, document text, or encoded images. */
export const isSiteIconPixels = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 1368 && /^[A-Za-z0-9+/]{1366}==$/.test(value);
export class VisitedSiteIcons {
  private readonly icons = new Map<string, string>();
  private key(scope: Scope, raw: string) {
    const origin = sourceIconOrigin(raw);
    return origin && JSON.stringify([scope.storeId, scope.sessionId, origin]);
  }
  record(scope: Scope, raw: string, pixels: unknown) {
    const key = this.key(scope, raw);
    if (!key || !isSiteIconPixels(pixels)) return;
    this.icons.delete(key);
    this.icons.set(key, pixels);
    if (this.icons.size > 128) this.icons.delete(this.icons.keys().next().value!);
  }
  get(scope: Scope, raw: string) {
    const key = this.key(scope, raw);
    return key ? this.icons.get(key) : undefined;
  }
}
/** Fixed isolated-world program. Only sample inline PNG bytes belonging to this document. */
export const readVisitedIcon = `(async () => {
 if(location.protocol !== 'https:') return;
 const links=document.querySelectorAll('link[rel~="icon" i]');
 for (let i=0;i<Math.min(4,links.length);i++) {
  const link=links[i];
  try {
   const href = link.href;
   if (href.length>43800 || !/^data:image\\/png;base64,[A-Za-z0-9+/]+=*$/i.test(href)) continue;
   const b = Uint8Array.from(atob(href.slice(href.indexOf(',')+1)), c=>c.charCodeAt(0));
   if(b.length<33 || b.length>32768) continue;
   const v=new DataView(b.buffer,b.byteOffset,b.byteLength), w=v.getUint32(16), h=v.getUint32(20);
   if(v.getUint32(0)!==0x89504e47 || v.getUint32(4)!==0x0d0a1a0a || v.getUint32(8)!==13 ||
      v.getUint32(12)!==0x49484452 || !w || !h || w>128 || h>128) continue;
   const img=await createImageBitmap(new Blob([b],{type:'image/png'}));
   try {
    if(img.width!==w||img.height!==h)continue;
    const c=new OffscreenCanvas(16,16),ctx=c.getContext('2d');if(!ctx)continue;
    const k=16/Math.max(w,h);ctx.drawImage(img,(16-w*k)/2,(16-h*k)/2,w*k,h*k);
    const px=ctx.getImageData(0,0,16,16).data;
    if(!px.some((v,i)=>i%4===3 && v>24))continue;
    return btoa(String.fromCharCode(...px));
   } finally {img.close();}
  } catch {}
 }
})()`;
