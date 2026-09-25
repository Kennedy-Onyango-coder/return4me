export type AppearancePreference = 'light' | 'dark' | 'system';
export type EffectiveAppearance = 'light' | 'dark';

export const APPEARANCE_STORAGE_KEY = 'return4me.appearance';
export const DARK_APPEARANCE_QUERY = '(prefers-color-scheme: dark)';

type AppearanceStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};
type MatchMedia = (query: string) => MediaQueryListLike | null | undefined;
type AppearanceQueryHost = { matchMedia?: MatchMedia };

export interface MediaQueryListLike {
  matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
}

export function browserAppearanceStorage(): AppearanceStorage | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

export function isAppearancePreference(value: unknown): value is AppearancePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Read one trusted appearance preference, failing closed to light. */
export function readStoredAppearance(storage: Pick<AppearanceStorage, 'getItem' | 'removeItem'> | null | undefined): AppearancePreference {
  if (!storage) return 'light';
  try {
    const stored = storage.getItem(APPEARANCE_STORAGE_KEY);
    if (isAppearancePreference(stored)) return stored;
    if (stored !== null) {
      try { storage.removeItem(APPEARANCE_STORAGE_KEY); } catch { /* best effort */ }
    }
  } catch { /* restricted storage must never prevent startup */ }
  return 'light';
}

/** Persist the user's preference, never the resolved system appearance. */
export function persistAppearance(storage: Pick<AppearanceStorage, 'setItem'> | null | undefined, preference: AppearancePreference): void {
  if (!storage || !isAppearancePreference(preference)) return;
  try { storage.setItem(APPEARANCE_STORAGE_KEY, preference); } catch { /* in-memory preference remains active */ }
}

function appearanceHost(host?: AppearanceQueryHost): AppearanceQueryHost | null {
  if (host) return host;
  if (typeof window === 'undefined') return null;
  return window as Window & typeof globalThis;
}

/** Resolve explicit preferences directly and unknown system preferences to light. */
export function resolveAppearance(
  preference: AppearancePreference,
  host?: AppearanceQueryHost,
): EffectiveAppearance {
  if (preference !== 'system') return preference;
  const matchMedia = appearanceHost(host)?.matchMedia;
  if (typeof matchMedia !== 'function') return 'light';
  try {
    return matchMedia.call(appearanceHost(host), DARK_APPEARANCE_QUERY)?.matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Subscribe only when preference is system; returns a safe cleanup function. */
export function subscribeToSystemAppearance(
  preference: AppearancePreference,
  onChange: () => void,
  host?: AppearanceQueryHost,
): () => void {
  if (preference !== 'system') return () => undefined;
  const resolvedHost = appearanceHost(host);
  if (!resolvedHost || typeof resolvedHost.matchMedia !== 'function') return () => undefined;

  let query: MediaQueryListLike | null | undefined;
  try {
    query = resolvedHost.matchMedia(DARK_APPEARANCE_QUERY);
  } catch {
    return () => undefined;
  }
  if (!query) return () => undefined;

  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
    return () => query?.removeEventListener?.('change', onChange);
  }
  if (typeof query.addListener === 'function') {
    query.addListener(onChange);
    return () => query?.removeListener?.(onChange);
  }
  return () => undefined;
}

/** The one canonical root marker always receives a resolved value. */
export function applyAppearanceMarker(root: Pick<Element, 'setAttribute'> | null | undefined, appearance: EffectiveAppearance): void {
  if (!root) return;
  try { root.setAttribute('data-theme', appearance); } catch { /* marker is presentation-only */ }
}
