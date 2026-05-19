import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { GateView } from './GateView';
import './index.css';

/**
 * Same renderer bundle is used by two windows:
 *  - main window → full app (sidebar + pages)
 *  - gate-simulator window → minimal red/green panel (?view=gate)
 *
 * Picking by querystring keeps the bundle to one Vite build with no extra
 * entrypoint config.
 */
const view = new URLSearchParams(location.search).get('view');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {view === 'gate' ? <GateView /> : <App />}
  </React.StrictMode>,
);
