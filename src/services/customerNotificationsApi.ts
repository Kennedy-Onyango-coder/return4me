import type { CustomerNotificationState } from '../config/customerNotifications';

// ===========================================================================
// BATCH 1 - CUSTOMER NOTIFICATION API CLIENT.
//
// The typed boundary the Notification Centre talks to. It mirrors the shape the
// server already returns (services/customerNotifications.ts -> routes/
// customerNotifications.ts) rather than inventing a second model for the UI, so a
// field the server does not expose cannot appear here by accident.
//
// EVERY call is `credentials: 'same-origin'`, because authorization is the
// httpOnly session cookie. There is no customer id in any request — the server
// takes identity from the cookie alone, so there is nothing here for a caller to
// tamper with.
// ===========================================================================

export interface CustomerNotification {
  id: string;
  category: string;
  title: string;
  body: string | null;
  /** The customer's own case/report reference. */
  reference: string | null;
  /** Derived server-side from the authoritative business state. */
  state: CustomerNotificationState;
  actionAvailable: boolean;
  actionPath: string | null;
  read: boolean;
  readAt: string | null;
  expired: boolean;
  createdAt: string;
  expiresAt: string;
  viaFallback: boolean;
}

export interface NotificationPreferenceChannel {
  channel: string;
  enabled: boolean;
  configurable: boolean;
}

export interface NotificationPreference {
  category: string;
  essential: boolean;
  channels: NotificationPreferenceChannel[];
}

export interface SetPreferenceResponse {
  applied: boolean;
  category: string;
  channel: string;
  enabled: boolean;
  reason?: string;
  preferences: NotificationPreference[];
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // A failed read is surfaced as a thrown error the caller handles in service
    // terms. The raw status/body is deliberately not re-exported to the UI.
    throw new Error('request_failed');
  }
  return (await res.json()) as T;
}

export async function listMyNotifications(): Promise<{
  notifications: CustomerNotification[];
  unread: number;
}> {
  return readJson(
    await fetch('/api/customer/notifications', { credentials: 'same-origin' }),
  );
}

export async function listMyNotificationHistory(): Promise<{
  notifications: CustomerNotification[];
}> {
  return readJson(
    await fetch('/api/customer/notifications/history', { credentials: 'same-origin' }),
  );
}

/** Opening a notification marks it read, server-side. */
export async function openMyNotification(id: string): Promise<CustomerNotification> {
  const body = await readJson<{ notification: CustomerNotification }>(
    await fetch(`/api/customer/notifications/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
    }),
  );
  return body.notification;
}

export async function getMyPreferences(): Promise<NotificationPreference[]> {
  const body = await readJson<{ preferences: NotificationPreference[] }>(
    await fetch('/api/customer/notifications/preferences', { credentials: 'same-origin' }),
  );
  return body.preferences;
}

/**
 * A refusal comes back as `applied: false` with a reason, which is a successful
 * exchange rather than an error — so this resolves normally and the caller shows
 * the reason instead of inventing one.
 */
export async function setMyPreference(
  category: string,
  channel: string,
  enabled: boolean,
): Promise<SetPreferenceResponse> {
  return readJson(
    await fetch('/api/customer/notifications/preferences', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category, channel, enabled }),
    }),
  );
}
