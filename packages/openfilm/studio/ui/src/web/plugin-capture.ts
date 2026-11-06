/** Narrow pixel capability; no arbitrary browser/DevTools access is exposed to the page. */
const PROTOCOL = 'fde2e-film-pixels/1';
let available = false;
const requests = new Map<string, { done: (value: Record<string, unknown>) => void; timer: number }>();
let wired = false;
let closing=Promise.resolve();
function wire() {
  if (wired) return; wired = true;
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.protocol !== PROTOCOL || !event.data.result) return;
    const pending = requests.get(event.data.id); if (!pending) return;
    requests.delete(event.data.id); clearTimeout(pending.timer); pending.done(event.data.result);
  });
}
async function request(action: string, timeoutMs: number, payload:Record<string,unknown> = {}): Promise<Record<string, unknown>> {
  wire(); const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { requests.delete(id); available = false; reject(new Error('Browser pixel bridge timed out')); }, timeoutMs);
    requests.set(id, { timer, done: (result) => result.ok ? resolve(result) : reject(new Error(String(result.error ?? 'Browser capture refused'))) });
    window.postMessage({protocol:PROTOCOL,id,action,...payload},location.origin);
  });
}
export const pluginCaptureAvailable = () => available;
export async function probePluginCapture(): Promise<boolean> {
  try { const r = await request('probe', 1500); available = r.available === true; } catch { available = false; }
  return available;
}
export async function capturePluginFrame(handle?:string): Promise<ImageBitmap> {
  const result = await request('capture', 30_000,handle?{handle}:{});
  if (typeof result.imageBase64 !== 'string' || result.mime !== 'image/png') throw new Error('invalid Browser frame');
  const data = Uint8Array.from(atob(result.imageBase64), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([data], {type:'image/png'}));
}
export async function openPluginRender(projectId:string,size:{w:number;h:number}){
  await closing;
  const opened=await request('renderOpen',30_000,{projectId,width:size.w,height:size.h});
  const handle=String(opened.handle);
  let closed:Promise<void>|undefined;
  return {seek:async(t:number)=>{await request('renderSeek',30_000,{handle,t});},capture:()=>capturePluginFrame(handle),close:()=>{
    if(!closed){closed=request('renderClose',5_000,{handle}).then(()=>{},()=>{});closing=closed;}
    return closed;
  }};
}
