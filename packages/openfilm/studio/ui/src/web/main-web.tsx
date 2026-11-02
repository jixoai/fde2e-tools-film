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

window.filmWeb = true;
applyStudioHost();

createRoot(document.getElementById('root')!).render(<StrictMode><FocusNav /><App /></StrictMode>);
