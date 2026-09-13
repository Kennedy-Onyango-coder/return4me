import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import CustomerDashboard from './CustomerDashboard';

interface Props {
  lang: 'en' | 'sw';
  onExit: () => void;
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

export default function CustomerAccountView({ lang, onExit }: Props) {
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
    } catch {
      setError(t('Network error. Please try again.', 'Hitilafu ya mtandao. Tafadhali jaribu tena.'));
    } finally {
      setBusy(false);
    }
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
    } catch {
      setError(t('Could not sign out. Please try again.', 'Imeshindwa kutoka. Tafadhali jaribu tena.'));
    } finally {
      setBusy(false);
    }
  };

  if (checking) {
    return (
      <div className="flex-grow flex items-center justify-center w-full py-24">
        <Loader2 className="animate-spin text-primary-green" size={26} />
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
      />
    );
  }

  const inputClass =
    'mt-1.5 w-full h-11 px-3 rounded-lg border border-brand-border bg-white text-sm text-brand-dark-text focus:outline-none focus:ring-2 focus:ring-primary-green/40 focus:border-primary-green';
  const primaryButtonClass =
    'w-full h-11 rounded-lg bg-primary-green text-white text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed transition-colors hover:opacity-90';
  const tabClass = (active: boolean) =>
    'py-2 text-sm font-semibold rounded-md transition-colors cursor-pointer ' +
    (active ? 'bg-white text-brand-dark-text shadow-sm' : 'text-brand-muted-text hover:text-brand-dark-text');

  return (
    <div className="w-full flex-grow flex items-start justify-center px-4 py-8 sm:py-14">
      <div className="w-full max-w-md">
        <div className="mb-5">
          <h1 className="text-xl sm:text-2xl font-bold text-brand-dark-text">
            {t('Your Return4me account', 'Akaunti yako ya Return4me')}
          </h1>
          <p className="mt-1 text-sm text-brand-muted-text leading-relaxed">
            {t(
              'A Return4me account is your persistent identity. It is separate from the ownership evidence you provide for a specific claim.',
              'Akaunti ya Return4me ni utambulisho wako wa kudumu. Ni tofauti na ushahidi wa umiliki unaotoa kwa claim mahususi.'
            )}
          </p>
        </div>

        <div className="bg-white border border-brand-border rounded-lg">
            <div className="p-5 sm:p-6">
              <div className="grid grid-cols-2 gap-1 p-1 bg-brand-light-gray rounded-lg" role="tablist">
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
                    <div>
                      <label htmlFor="customer-name" className="block text-sm font-semibold text-brand-dark-text">
                        {t('Full name', 'Jina kamili')}
                      </label>
                      <input id="customer-name" type="text" value={fullName} onChange={(e) => setFullName(e.target.value)}
                        autoComplete="name" maxLength={120} className={inputClass}
                        placeholder={t('e.g. Wanjiku Kamau', 'k.m. Wanjiku Kamau')} />
                    </div>
                  )}

                  <div>
                    <label htmlFor="customer-phone" className="block text-sm font-semibold text-brand-dark-text">
                      {t('M-Pesa phone number', 'Nambari ya simu ya M-Pesa')}
                    </label>
                    <input id="customer-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                      autoComplete="tel" maxLength={16} className={inputClass} placeholder="07XX XXX XXX" />
                    <p className="mt-1.5 text-xs text-brand-muted-text leading-relaxed">
                      {t(
                        "We'll text a one-time verification code to this number.",
                        'Tutatuma msimbo wa uthibitisho wa mara moja kwa nambari hii kwa SMS.'
                      )}
                    </p>
                  </div>

                  {error && <InlineMessage kind="error" text={error} />}

                  <button type="submit" disabled={busy} className={primaryButtonClass}>
                    {busy
                      ? t('Sending code…', 'Inatuma msimbo…')
                      : t('Send verification code', 'Tuma msimbo wa uthibitisho')}
                  </button>
                </form>
              ) : (
                <form onSubmit={verifyCode} className="mt-5 space-y-4" noValidate>
                  {notice && <InlineMessage kind="info" text={notice} />}

                  <div>
                    <label htmlFor="customer-code" className="block text-sm font-semibold text-brand-dark-text">
                      {t('Verification code', 'Msimbo wa uthibitisho')}
                    </label>
                    <input id="customer-code" type="text" inputMode="numeric" value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      autoComplete="one-time-code" maxLength={6} className={inputClass} placeholder="123456" />
                    <p className="mt-1.5 text-xs text-brand-muted-text leading-relaxed">
                      {t('We sent it to', 'Tuliituma kwa')} {formatPhoneForDisplay(phone)}
                    </p>
                  </div>

                  {error && <InlineMessage kind="error" text={error} />}

                  <button type="submit" disabled={busy} className={primaryButtonClass}>
                    {busy
                      ? t('Verifying…', 'Inathibitisha…')
                      : t('Verify and continue', 'Thibitisha na uendelee')}
                  </button>

                  <button type="button" onClick={() => { setStep('details'); setCode(''); resetMessages(); }}
                    className="w-full text-xs font-semibold text-brand-muted-text hover:text-brand-dark-text cursor-pointer">
                    {t('Use a different number', 'Tumia nambari nyingine')}
                  </button>
                </form>
              )}
            </div>
        </div>

        <button type="button" onClick={onExit} className="mt-4 text-xs font-semibold text-primary-green hover:underline cursor-pointer">
          {t('Back to Return4me', 'Rudi Return4me')}
        </button>
      </div>
    </div>
  );
}

function InlineMessage({ kind, text }: { kind: 'error' | 'info'; text: string }) {
  const cls = kind === 'error'
    ? 'border-red-200 bg-red-50 text-red-700'
    : 'border-brand-border bg-brand-light-gray text-brand-dark-text';
  return (
    <div className={`mt-4 rounded-md border px-3 py-2 text-xs leading-relaxed ${cls}`} role={kind === 'error' ? 'alert' : 'status'}>
      {text}
    </div>
  );
}
