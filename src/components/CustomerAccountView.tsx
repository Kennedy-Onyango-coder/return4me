import React, { useEffect, useState } from 'react';
import CustomerDashboard from './CustomerDashboard';
import { Banner, Button, Input, Spinner } from './ui';

interface Props {
  lang: 'en' | 'sw';
  onExit: () => void;
  /** Phase 7B: fired once a session has actually been established (register or
   *  sign-in verified). The app uses it to return the visitor to the public
   *  item page they came from, so /item/:id → "It's Mine" → sign in → back to
   *  /item/:id can finish the journey instead of dead-ending on the dashboard.
   *  Optional: the surface behaves identically without it. */
  onAuthenticated?: () => void;
  /**
   * PHASE 11B: fired whenever the session this surface was holding ends — an
   * explicit sign-out, or a 401 from an authenticated read. App uses it to clear
   * the customer session the site chrome is rendering, so the navbar cannot keep
   * showing "My Account"/"Logout" after that session is actually gone. Optional:
   * the surface behaves identically without it.
   */
  onSessionEnded?: () => void;
  /** Phase 9C: opens the public /item/:id page for a possible match, which is
   *  where the existing "It's Mine" ownership journey begins. */
  onOpenItem: (itemId: string) => void;
}

type Mode = 'register' | 'login';
type Step = 'details' | 'otp';

interface Customer {
  id: string;
  full_name: string;
  phone: string;
  status: string;
  created_at: string | null;
  updated_at: string | null;
}

// Mirrors the server's own normalization (services/auth.ts toE164Kenyan):
// 0XXXXXXXXX or 254XXXXXXXXX / +254XXXXXXXXX becomes +254XXXXXXXXX, which is
// what the API requires. The server remains the source of truth; this only
// gives the user immediate feedback.
function normalizeKenyanPhone(input: string): string | null {
  const clean = input.replace(/[\s-]/g, '');
  if (/^0\d{9}$/.test(clean)) return '+254' + clean.slice(1);
  if (/^254\d{9}$/.test(clean)) return '+' + clean;
  if (/^\+254\d{9}$/.test(clean)) return clean;
  return null;
}

function formatPhoneForDisplay(phone: string): string {
  // +254712345678 -> 0712 345 678
  if (/^\+254\d{9}$/.test(phone)) {
    return '0' + phone.slice(4, 7) + ' ' + phone.slice(7, 10) + ' ' + phone.slice(10);
  }
  return phone;
}

export default function CustomerAccountView({ lang, onExit, onAuthenticated, onOpenItem, onSessionEnded }: Props) {
  const sw = lang === 'sw';
  const t = (en: string, swText: string) => (sw ? swText : en);

  const [mode, setMode] = useState<Mode>('register');
  const [step, setStep] = useState<Step>('details');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);

  // Resolve an existing session on load, so a refresh keeps the user signed in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/customer/me');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setCustomer(data.customer);
        }
      } catch {
        // Not signed in — fall through to the register/login form.
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const resetMessages = () => { setError(null); setNotice(null); };

  const switchMode = (next: Mode) => {
    setMode(next);
    setStep('details');
    setCode('');
    resetMessages();
  };

  const requestCode = async (e: React.FormEvent) => {
    e.preventDefault();
    resetMessages();
    if (mode === 'register' && fullName.trim().length < 2) {
      setError(t('Enter your full name.', 'Weka jina lako kamili.'));
      return;
    }
    const normalized = normalizeKenyanPhone(phone);
    if (!normalized) {
      setError(t('Enter a valid Kenyan M-Pesa phone number.', 'Weka nambari sahihi ya simu ya Kenya.'));
      return;
    }
    setBusy(true);
    try {
      const endpoint = mode === 'register' ? '/api/customer/register' : '/api/customer/login';
      const body = mode === 'register'
        ? { fullName: fullName.trim(), phone: normalized }
        : { phone: normalized };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || t('Something went wrong. Please try again.', 'Kuna hitilafu. Tafadhali jaribu tena.'));
        return;
      }
      setPhone(normalized);
      setStep('otp');
      setNotice(
        data?.message ||
        t('A verification code has been sent to your phone.', 'Msimbo wa uthibitisho umetumwa kwenye simu yako.')
      );
    } catch {
      setError(t('Network error. Please try again.', 'Hitilafu ya mtandao. Tafadhali jaribu tena.'));
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    resetMessages();
    if (!/^\d{6}$/.test(code.trim())) {
      setError(t('Enter the 6-digit code from the SMS.', 'Weka msimbo wa tarakimu 6 kutoka kwa SMS.'));
      return;
    }
    setBusy(true);
    try {
      const endpoint = mode === 'register' ? '/api/customer/register/verify' : '/api/customer/login/verify';
      const body = mode === 'register'
        ? { fullName: fullName.trim(), phone, code: code.trim() }
        : { phone, code: code.trim() };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || t('Verification failed. Please try again.', 'Uthibitisho umeshindikana. Tafadhali jaribu tena.'));
        return;
      }
      setCustomer(data.customer);
      setCode('');
      setStep('details');
      setNotice(null);
      // Phase 7B: the session now exists — let the app restore the visitor's
      // intended destination (an /item/:id page they pressed "It's Mine" on).
      onAuthenticated?.();
    } catch {
      setError(t('Network error. Please try again.', 'Hitilafu ya mtandao. Tafadhali jaribu tena.'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Phase 9C: an authenticated read inside the dashboard was rejected with 401
   * (expired or revoked session). Drop straight back to the sign-in card and say
   * why — no private data stays on screen, and no second authentication
   * mechanism is introduced.
   */
  const handleSessionExpired = () => {
    setCustomer(null);
    // PHASE 11B: the session is gone server-side — tell App so the site chrome
    // stops showing an authenticated state.
    onSessionEnded?.();
    setMode('login');
    setStep('details');
    setCode('');
    setError(null);
    setNotice(t(
      'Your session has ended. Please sign in again to continue.',
      'Kipindi chako kimeisha. Tafadhali ingia tena ili kuendelea.'
    ));
  };

  const logout = async () => {
    setBusy(true);
    resetMessages();
    try {
      await fetch('/api/customer/logout', { method: 'POST', credentials: 'same-origin' });
      setCustomer(null);
      setMode('register');
      setStep('details');
      setFullName('');
      setPhone('');
      setCode('');
      // PHASE 11B: the cookie session is revoked — clear it from the site chrome.
      onSessionEnded?.();
    } catch {
      setError(t('Could not sign out. Please try again.', 'Imeshindwa kutoka. Tafadhali jaribu tena.'));
    } finally {
      setBusy(false);
    }
  };

  if (checking) {
    return (
      <div className="flex-grow flex items-center justify-center w-full py-24">
        <Spinner
          size={26}
          label={t('Checking your session', 'Inathibitisha kipindi chako')}
          className="text-primary-green"
        />
      </div>
    );
  }
  // Authenticated: hand over to the dashboard. It renders its own sections
  // (identity, My claims, link/unlink) and owns the sign-out action, so it is
  // returned here rather than nested inside the sign-in card.
  if (customer) {
    return (
      <CustomerDashboard
        lang={lang}
        customer={customer}
        onSignOut={logout}
        signingOut={busy}
        onOpenItem={onOpenItem}
        onSessionExpired={handleSessionExpired}
      />
    );
  }

  // The two mode controls are the only hand-styled controls left on this
  // surface: they are a segmented switch rather than a Button, and they keep
  // their existing tablist semantics. 44px tall so they meet the same
  // touch-target floor as every other control in the account journey.
  const tabClass = (active: boolean) =>
    'min-h-11 inline-flex items-center justify-center py-2 text-sm font-bold rounded-lg transition-colors cursor-pointer ' +
    (active ? 'bg-white text-brand-dark-text shadow-sm' : 'text-brand-muted-text hover:text-brand-dark-text');

  return (
    <div className="w-full flex-grow flex items-start justify-center px-4 py-8 sm:py-12">
      <div className="w-full max-w-md space-y-4">
        {/* ACCOUNT ENTRY CARD - eyebrow, one clear heading and the explanation
            of why a session is needed, then the SAME register/sign-in flow this
            surface already ran: the same modes, the same two steps, the same
            endpoints, the same validation and the same messages. Only the
            presentation moved onto the shared primitives. */}
        <div className="bg-white border border-brand-border rounded-2xl p-5 sm:p-6">
          <p className="text-[11px] font-extrabold uppercase tracking-widest text-brand-muted-text">
            {t('Return4me account', 'Akaunti ya Return4me')}
          </p>
          <h1 className="mt-1 text-xl sm:text-2xl font-extrabold tracking-tight text-brand-dark-text">
            {t('Your Return4me account', 'Akaunti yako ya Return4me')}
          </h1>
          <p className="mt-1.5 text-sm text-brand-muted-text leading-relaxed">
            {t(
              'A Return4me account is your persistent identity. It is separate from the ownership evidence you provide for a specific claim.',
              'Akaunti ya Return4me ni utambulisho wako wa kudumu. Ni tofauti na ushahidi wa umiliki unaotoa kwa claim mahususi.'
            )}
          </p>

          <div className="mt-5 grid grid-cols-2 gap-1 p-1 bg-brand-light-gray rounded-xl" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'register'} onClick={() => switchMode('register')} className={tabClass(mode === 'register')}>
              {t('Register', 'Sajili')}
            </button>
            <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => switchMode('login')} className={tabClass(mode === 'login')}>
              {t('Sign in', 'Ingia')}
            </button>
          </div>

          {step === 'details' ? (
            <form onSubmit={requestCode} className="mt-5 space-y-4" noValidate>
              {mode === 'register' && (
                <Input
                  id="customer-name"
                  label={t('Full name', 'Jina kamili')}
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  autoComplete="name"
                  maxLength={120}
                  placeholder={t('e.g. Wanjiku Kamau', 'k.m. Wanjiku Kamau')}
                />
              )}

              <Input
                id="customer-phone"
                label={t('M-Pesa phone number', 'Nambari ya simu ya M-Pesa')}
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                maxLength={16}
                placeholder="07XX XXX XXX"
                hint={t(
                  "We'll text a one-time verification code to this number.",
                  'Tutatuma msimbo wa uthibitisho wa mara moja kwa nambari hii kwa SMS.'
                )}
              />

              {notice && <Banner kind="info">{notice}</Banner>}
              {error && <Banner kind="error">{error}</Banner>}

              <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
                {busy
                  ? t('Sending code…', 'Inatuma msimbo…')
                  : t('Send verification code', 'Tuma msimbo wa uthibitisho')}
              </Button>
            </form>
          ) : (
            <form onSubmit={verifyCode} className="mt-5 space-y-4" noValidate>
              {notice && <Banner kind="info">{notice}</Banner>}

              <Input
                id="customer-code"
                label={t('Verification code', 'Msimbo wa uthibitisho')}
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                hint={t('We sent it to', 'Tuliituma kwa') + ' ' + formatPhoneForDisplay(phone)}
              />

              {error && <Banner kind="error">{error}</Banner>}

              <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
                {busy
                  ? t('Verifying…', 'Inathibitisha…')
                  : t('Verify and continue', 'Thibitisha na uendelee')}
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={() => { setStep('details'); setCode(''); resetMessages(); }}
                className="w-full"
              >
                {t('Use a different number', 'Tumia nambari nyingine')}
              </Button>
            </form>
          )}
        </div>

        <Button type="button" variant="ghost" size="md" onClick={onExit} className="w-full sm:w-auto">
          {t('Back to Return4me', 'Rudi Return4me')}
        </Button>
      </div>
    </div>
  );
}
