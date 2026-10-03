// =============================================================================
// BATCH 1 — CUSTOMER NOTIFICATION USER LAYER (routes).
//
// WHY A SEPARATE MODULE
//   server.ts constructs the application and calls startServer() at import time,
//   so it cannot be imported by a test without booting Vite middleware, sweeps
//   and listeners. Registering into the caller's Express app — the same pattern
//   routes/customerClaims.ts uses — lets the HTTP tests mount a REAL app around
//   the REAL middleware and the REAL handlers.
//
// AUTHORIZATION MODEL (requirement 16)
//   Identity comes ONLY from req.customer, resolved by requireCustomerAuth from
//   the session cookie's hash. No customer id from the body, the query string, a
//   notification id, or a path segment is ever trusted. Every handler passes
//   req.customer.id into a service function whose SQL is scoped by customer_id,
//   so a wrong or guessed id returns an empty result or 404 — never another
//   customer's data. Hiding a button in the UI is never the control.
//
// WHAT THIS ROUTE DOES NOT DO
//   It does not deliver, retry, or report delivery. It never reads
//   notification_events, so no provider name, error string, retry counter or
//   infrastructure detail can reach a response body by any path.
// =============================================================================

import { requireCustomerAuth } from '../services/customerAuth.ts';
import {
  countUnreadActive,
  getCustomerPreferences,
  listActiveCustomerNotifications,
  listCustomerNotificationHistory,
  openCustomerNotification,
  setCustomerPreference,
} from '../services/customerNotifications.ts';
import { CUSTOMER_NOTIFICATION_CHANNELS } from '../config/customerNotifications.ts';

const SERVER_ERROR = {
  error: 'Hitilafu imetokea upande wa seva. Tafadhali jaribu tena baadaye.',
};

export function registerCustomerNotificationRoutes(app: any) {
  // ---------------------------------------------------------------------------
  // The ACTIVE list, plus the unread count the indicator badge needs.
  //
  // Both come from ONE endpoint on purpose: the badge and the list can never
  // disagree, because they are computed from the same rows at the same instant.
  // ---------------------------------------------------------------------------
  app.get('/api/customer/notifications', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const now = new Date();
      const [notifications, unread] = await Promise.all([
        listActiveCustomerNotifications(req.customer.id, { now }),
        countUnreadActive(req.customer.id, now),
      ]);
      return res.json({ notifications, unread });
    } catch (e) {
      console.error('[CUSTOMER_NOTIFICATIONS_LIST_ERROR]', e);
      return res.status(500).json(SERVER_ERROR);
    }
  });

  // ---------------------------------------------------------------------------
  // NOTIFICATION HISTORY (requirement 2).
  //
  // Separate from the active list on purpose: history includes expired and
  // completed entries, and a customer who wants to look back is asking a
  // different question from one who wants what needs attention now.
  // ---------------------------------------------------------------------------
  app.get('/api/customer/notifications/history', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const notifications = await listCustomerNotificationHistory(req.customer.id);
      return res.json({ notifications });
    } catch (e) {
      console.error('[CUSTOMER_NOTIFICATIONS_HISTORY_ERROR]', e);
      return res.status(500).json(SERVER_ERROR);
    }
  });

  // ---------------------------------------------------------------------------
  // Open one notification (requirement 3).
  //
  // Opening IS marking it read, so the customer never has to find a separate
  // "mark as read" control for the ordinary case. The service re-checks
  // ownership in its WHERE clause, so a guessed id from another customer is a
  // 404 here — identical to a genuinely missing id, so this endpoint cannot be
  // used to probe for the existence of another customer's notifications.
  //
  // The returned actionPath is only present when the underlying business state
  // still supports the action; following it lands on a route that performs its
  // OWN authorization check, so a stale or hand-edited path grants nothing.
  // ---------------------------------------------------------------------------
  app.get('/api/customer/notifications/:id', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const notification = await openCustomerNotification(req.customer.id, req.params.id);
      if (!notification) {
        return res.status(404).json({ error: 'Taarifa haikupatikana. / Notification not found.' });
      }
      return res.json({ notification });
    } catch (e) {
      console.error('[CUSTOMER_NOTIFICATION_OPEN_ERROR]', e);
      return res.status(500).json(SERVER_ERROR);
    }
  });

  // ---------------------------------------------------------------------------
  // Preferences (requirements 7 and 8).
  // ---------------------------------------------------------------------------
  app.get('/api/customer/notifications/preferences', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const preferences = await getCustomerPreferences(req.customer.id);
      return res.json({ preferences, channels: CUSTOMER_NOTIFICATION_CHANNELS });
    } catch (e) {
      console.error('[CUSTOMER_NOTIFICATION_PREFS_GET_ERROR]', e);
      return res.status(500).json(SERVER_ERROR);
    }
  });

  /**
   * Change one preference.
   *
   * The response CONFIRMS the outcome to the customer rather than assuming
   * success: a refused essential notification comes back with applied = false and
   * a plain-language reason, so the UI can tell the customer their request was
   * not honoured instead of silently reverting a toggle they believed they set.
   *
   * The essential-vs-optional decision is made SERVER-SIDE from the category,
   * never from the request body, so this cannot be used to suppress a required
   * notification.
   */
  app.post('/api/customer/notifications/preferences', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const { category, channel, enabled } = req.body ?? {};
      if (typeof category !== 'string' || typeof channel !== 'string' || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Ombi la awali si sahihi. / Invalid request.' });
      }
      const result = await setCustomerPreference(req.customer.id, category, channel, enabled);
      // A refusal is a 200 with applied = false, not an error: the request was
      // understood and answered honestly, and the customer's preference is
      // unchanged. A 4xx here would read as "the app is broken".
      return res.json({ ...result, preferences: await getCustomerPreferences(req.customer.id) });
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Unknown notification')) {
        return res.status(400).json({ error: 'Ombi la awali si sahihi. / Invalid request.' });
      }
      console.error('[CUSTOMER_NOTIFICATION_PREFS_SET_ERROR]', e);
      return res.status(500).json(SERVER_ERROR);
    }
  });
}
