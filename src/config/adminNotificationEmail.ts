// ADMIN NOTIFICATION RECIPIENT — resolved by the CALLER, not by the provider.
//
// N8 moved this out of services/email.ts. Previously the two admin email
// templates read process.env.ADMIN_NOTIFICATION_EMAIL internally and returned
// false when it was unset. That put recipient selection inside the transport,
// which is exactly what the notification boundary exists to prevent:
// NotificationService takes the recipient from its caller, normalizes it, and
// records a masked reference for it.
//
// Concretely: if this returns '', the caller passes '' as the recipient and
// NotificationService rejects the event with `missing_recipient` before any
// provider call and before anything is stored. No email is sent either way, so
// the delivery behaviour is unchanged — only the reason moves from a silent
// provider-level `false` to a recorded, inspectable policy rejection.
//
// This is the ONLY place in the application that reads this variable, so the
// configuration has exactly one definition site.

/**
 * The configured administrative notification address, or '' when unset.
 *
 * `env` is injectable so this is directly unit-testable without mutating
 * `process.env`, matching readGeocodingConfig() in src/db/index.ts.
 */
export function getAdminNotificationEmail(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ADMIN_NOTIFICATION_EMAIL;
  return typeof configured === 'string' ? configured.trim() : '';
}