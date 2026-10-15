import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Corporate from './apps/Corporate';
import Distributor from './apps/Distributor';
import Employee from './apps/Employee';
import Home from './apps/Home';
import Station from './apps/Station';
import './styles.css';
import { ToastProvider } from './ui';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/distributor/*" element={<Distributor />} />
          <Route path="/corporate/*" element={<Corporate />} />
          <Route path="/station/*" element={<Station />} />
          <Route path="/employee/*" element={<Employee />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);

// Offline support (production builds only; the dev server serves modules that shouldn't be cached).
// The station app installs as its own home-screen app (opens on /station); everything else installs the wallet.
if (location.pathname.startsWith('/station')) {
  document.querySelector('link[rel=manifest]')?.setAttribute('href', '/station.webmanifest');
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
