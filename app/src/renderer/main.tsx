import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SiteProvider } from '../context/SiteContext';
import './index.css';

/**
 * Single renderer entrypoint — the main window (sidebar + pages).
 *
 * The old `?view=gate` branch rendered a full-screen red/green "GATE CLOSED"
 * simulator window. Removed 2026-08-07: the barrier is real hardware driven by
 * the camera's IO relay, so a second always-on-top window popping up on every
 * pulse was pure noise.
 */
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SiteProvider>
      <App />
    </SiteProvider>
  </React.StrictMode>,
);
