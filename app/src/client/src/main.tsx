import { StrictMode } from 'react';
import {
  createRoot,
} from 'react-dom/client';

import { App } from './App';
import { AppProvider } from './contexts/AppContext';
import './i18n/i18n';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
