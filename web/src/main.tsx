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
