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

window.filmWeb = true;
applyStudioHost();

// the web file server: /wf/<id>/… answered from OPFS (film pages, media, covers load as URLs)
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/opfs-sw.js');
}

createRoot(document.getElementById('root')!).render(<StrictMode><FocusNav /><App /></StrictMode>);

// The WebMCP tool surface (4.1): the four families once the page can answer them. projects_open
// navigates the same way the app's own `open` does (the address bar IS the app's router).
void registerWebMCPTools((id) => {
  if (location.pathname !== `/projects/${id}`) history.pushState(null, '', `/projects/${id}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
});
