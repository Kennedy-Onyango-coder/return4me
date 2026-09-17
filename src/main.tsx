import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import * as Sentry from '@sentry/react';
// PHASE 10 (F-5): the SAME DSN acceptability policy the Node server uses.
// The previous inline guard here only rejected an empty value and the substring
// 'REPLACE_WITH', and the success line was printed merely because
// Sentry.init() had not thrown — but it does not throw on an unusable DSN, so
// the browser console announced error tracking as live when no event could be
// delivered. See config/sentryDsn.ts; it is pure and isomorphic precisely so
// this policy has one implementation rather than two drifting copies.
import { isSentryDsnUsable, sentryDsnProblem, sentryDsnProblemLabel } from './config/sentryDsn';

const sentryDsnFrontend = (import.meta as any).env.VITE_SENTRY_DSN_FRONTEND;
const sentryFrontendDsnProblem = sentryDsnProblem(sentryDsnFrontend);
const isSentryFrontendEnabled = isSentryDsnUsable(sentryDsnFrontend);

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
    console.log('[SENTRY] Frontend error tracking initialised with a configured, well-formed DSN. Provider-side delivery is not verified here.');
  } catch (err) {
    // Initialisation itself failed. Report that — never success.
    console.error('[SENTRY ERROR] Failed to initialize Sentry Frontend:', err);
  }
} else {
  console.log(`[SENTRY] Frontend error tracking is DISABLED — Sentry DSN is ${sentryDsnProblemLabel(sentryFrontendDsnProblem ?? 'missing')}. No error events will be sent.`);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
