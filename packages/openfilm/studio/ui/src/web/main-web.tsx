/**
 * The pure-web entry (film.tool.fde2e.com): Studio's editor on the OPFS store, no server. Sets the
 * web flag first (every module may ask it), then mounts the same App. The index.html that names this
 * module is the web build's; the server build keeps main.tsx untouched.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App';
import { FocusNav } from '../components/FocusNav';
import '../globals.css';
import { applyStudioHost } from '../lib/host';
import { registerWebMCPTools } from './webmcp-register';
import { installPackageChannel } from './package-channel';
import { probePluginCapture } from './plugin-capture';
import { installProjectIntake } from './project-intake';

window.filmWeb = true;
applyStudioHost();

// The OPFS URL face is a boot dependency, not a best-effort enhancement. Exposing the project
// UI or WebMCP before this client is controlled creates a race where the first /wf/<id>/film.html
// hits the SPA fallback and the preview waits forever. `clients.claim()` makes a fresh first-load
// client controllable without a reload; wait for that observable state before mounting either face.
if (!('serviceWorker' in navigator)) throw new Error('FDE2E Film requires Service Worker support');
await navigator.serviceWorker.register('/opfs-sw.js');
await navigator.serviceWorker.ready;
if (!navigator.serviceWorker.controller) {
  await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
}

const renderId=new URL(location.href).searchParams.get('film-render');
if(renderId&&/^p-[a-z0-9-]+$/.test(renderId)){
  const {api}=await import('../api');const film=await api.film(renderId);
  const runtime=await(await import('./render-preview')).renderPreview(renderId,film.doc?.stage??{w:1920,h:1080},new AbortController().signal,true);
  Object.assign(window,{__fde2eFilmRender:runtime.source});
}else{
createRoot(document.getElementById('root')!).render(<StrictMode><FocusNav /><App /></StrictMode>);

// The WebMCP tool surface (4.1): the four families once the page can answer them. projects_open
// navigates the same way the app's own `open` does (the address bar IS the app's router).
const openProject = (id: string) => {
  if (location.pathname !== `/projects/${id}`) history.pushState(null, '', `/projects/${id}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
};
void probePluginCapture();
installPackageChannel(openProject);
installProjectIntake(openProject);
void registerWebMCPTools(openProject);
}
