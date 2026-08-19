import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import * as Sentry from '@sentry/react';

const sentryDsnFrontend = (import.meta as any).env.VITE_SENTRY_DSN_FRONTEND;
const isSentryFrontendEnabled = sentryDsnFrontend && !sentryDsnFrontend.includes('REPLACE_WITH') && sentryDsnFrontend.trim() !== '';

if (isSentryFrontendEnabled) {
  try {
    Sentry.init({
      dsn: sentryDsnFrontend,
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.replayIntegration(),
      ],
      tracesSampleRate: 1.0,
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
    });
    console.log('[SENTRY] Sentry Frontend initialized successfully.');
  } catch (err) {
    console.error('[SENTRY ERROR] Failed to initialize Sentry Frontend:', err);
  }
} else {
  console.log('[SENTRY] Missing or placeholder Sentry DSN detected. Sentry Frontend error tracking is disabled.');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
