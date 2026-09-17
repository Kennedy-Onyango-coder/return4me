import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, AlertCircle, Lock, MapPin, Package, ShieldCheck, Loader2 } from 'lucide-react';
import Button from './ui/Button';
import Badge from './ui/Badge';

// PUBLIC ITEM DETAIL (/item/:id)
// ==============================
// The public landing surface for a single found item. Everything it renders
// comes from GET /api/items/:id/public, which only ever returns the masked
// public representation (services/publicItemView.ts) and only for items that
// are currently publicly claimable. In particular this page never receives —
// and therefore can never leak — a document number, OCR-extracted name, finder
// contact, the item's GPS coordinates, or the photo/description of a sensitive
// document.
//
// SECURITY BOUNDARY: the page is PUBLIC; treat every visitor as unauthenticated.
// "It's Mine" deliberately does NOT enter the private claim flow directly. It
// first establishes whether the visitor is an authenticated Return4me customer:
//   authenticated   -> continue into the claim journey for this item
//   not authenticated -> hand off to the existing customer sign-in/registration
//                        surface, preserving /item/<id> as the return destination
// The item id is carried in the URL, so the journey survives that boundary.
// The ownership verification inside the claim flow (security answers + phone +
// SMS OTP) is unchanged and remains the thing that actually proves ownership.

type LoadState = 'loading' | 'ready' | 'not_found' | 'error';

interface PublicItemViewProps {
  lang: 'en' | 'sw';
  /** Item id taken from the /item/:id URL. */
  itemId: string;
  categories: any[];
  /** Return to found-item discovery (home). */
  onBack: () => void;
  /** Authenticated visitor: continue into the claim journey for this item. */
  onContinueClaim: (item: any) => void;
  /** Unauthenticated visitor: hand off to the account/auth surface. */
  onRequireAuth: () => void;
}

export default function PublicItemView({
  lang,
  itemId,
  categories,
  onBack,
  onContinueClaim,
  onRequireAuth,
}: PublicItemViewProps) {
  const sw = lang === 'sw';
  const t = (en: string, swText: string) => (sw ? swText : en);

  const [state, setState] = useState<LoadState>('loading');
  const [item, setItem] = useState<any | null>(null);
  const [claimBusy, setClaimBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const loadItem = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState('loading');
    setItem(null);
    try {
      const res = await fetch(`/api/items/${encodeURIComponent(itemId)}/public`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (res.status === 404) {
        setState('not_found');
        return;
      }
      if (!res.ok) {
        setState('error');
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (!data || !data.item || !data.item.id) {
        // Malformed response — treat as not available rather than rendering
        // "undefined" placeholders.
        setState('not_found');
        return;
      }
      setItem(data.item);
      setState('ready');
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setState('error');
    }
  }, [itemId]);

  // One request per item id, aborted on unmount / rapid navigation between
  // items so a slow response for a previous id can never overwrite a newer one.
  useEffect(() => {
    mountedRef.current = true;
    loadItem();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, [loadItem]);

  // Screen readers announce document.title as the primary "the page changed"
  // signal; App owns the base title, so restore it on the way out.
  useEffect(() => {
    const previous = document.title;
    const label = item?.document_name_fuzzy ? ` — ${item.document_name_fuzzy}` : '';
    document.title = t(
      `Found item${label} | Return4me`,
      `Bidhaa iliyopatikana${label} | Return4me`
    );
    return () => {
      document.title = previous;
    };
  }, [item, lang]);

  const categoryName = (() => {
    const cat = categories.find((c: any) => c.id === item?.category_id);
    return cat ? (sw ? cat.name_sw : cat.name_en) : (item?.category_id || '');
  })();

  // "It's Mine" — the authentication boundary. The session check is a plain
  // authenticated GET; no hidden client flag decides it.
  const handleClaimClick = async () => {
    if (claimBusy || !item) return;
    setClaimBusy(true);
    try {
      const res = await fetch('/api/customer/me', { credentials: 'same-origin' });
      if (!mountedRef.current) return;
      if (res.ok) {
        onContinueClaim(item);
      } else {
        onRequireAuth();
      }
    } catch {
      // A failed session check must never be read as "authenticated": fail
      // closed into the sign-in boundary instead of the claim flow.
      if (mountedRef.current) onRequireAuth();
    } finally {
      if (mountedRef.current) setClaimBusy(false);
    }
  };

  const backLink = (
    <a
      href="/"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onBack();
      }}
      className="inline-flex items-center gap-1.5 text-xs font-bold text-primary-green hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-green/40 rounded"
    >
      <ArrowLeft size={14} aria-hidden="true" />
      {t('Back to found items', 'Rudi kwenye vitu vilivyopatikana')}
    </a>
  );

  return (
    <div className="w-full flex-grow px-4 sm:px-8 py-6 sm:py-10">
      <div className="mx-auto max-w-3xl">
        {backLink}

        {state === 'loading' && (
          <div
            className="mt-5 bg-white border border-brand-border rounded-2xl p-12 flex flex-col items-center justify-center gap-3"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="animate-spin text-primary-green" size={28} aria-hidden="true" />
            <span className="text-sm font-medium text-brand-muted-text">
              {t('Loading this found item…', 'Inapakia bidhaa hii iliyopatikana…')}
            </span>
          </div>
        )}

        {state === 'not_found' && (
          <div className="mt-5 bg-white border border-brand-border rounded-2xl p-8 sm:p-10 text-center">
            <Package size={32} aria-hidden="true" className="mx-auto text-brand-muted-text" />
            <h1 className="mt-4 text-xl font-bold text-brand-dark-text">
              {t('Item not found', 'Bidhaa haipatikani')}
            </h1>
            <p className="mt-2 text-sm text-brand-muted-text leading-relaxed">
              {t(
                'This item may no longer be publicly available. It may have been claimed, withdrawn, or the link may be incorrect.',
                'Bidhaa hii huenda haipatikani kwa umma tena. Inawezekana ilidaiwa, iliondolewa, au kiungo si sahihi.'
              )}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button variant="primary" size="md" onClick={onBack}>
                {t('Browse found items', 'Angalia vitu vilivyopatikana')}
              </Button>
            </div>
          </div>
        )}

        {state === 'error' && (
          <div
            className="mt-5 bg-white border border-brand-border rounded-2xl p-8 sm:p-10 text-center"
            role="alert"
          >
            <AlertCircle size={32} aria-hidden="true" className="mx-auto text-status-danger" />
            <h1 className="mt-4 text-xl font-bold text-brand-dark-text">
              {t('We could not load this item', 'Hatukuweza kupakia bidhaa hii')}
            </h1>
            <p className="mt-2 text-sm text-brand-muted-text leading-relaxed">
              {t(
                'Something went wrong on our side. Please try again.',
                'Kuna hitilafu upande wetu. Tafadhali jaribu tena.'
              )}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button variant="primary" size="md" onClick={loadItem}>
                {t('Try again', 'Jaribu tena')}
              </Button>
              <Button variant="outline" size="md" onClick={onBack}>
                {t('Browse found items', 'Angalia vitu vilivyopatikana')}
              </Button>
            </div>
          </div>
        )}

        {state === 'ready' && item && (
          <article className="mt-5 bg-white border border-brand-border rounded-2xl overflow-hidden">
            <div className="grid grid-cols-1 sm:grid-cols-2">
              {/* Media — a sensitive document's photo is never sent by the API,
                  so the "hidden" panel below is a server-enforced fact, not a
                  client-side choice. */}
              <div className="aspect-[4/3] bg-brand-light-gray relative">
                {item.photo_url ? (
                  <img
                    src={item.photo_url}
                    alt={t(
                      `${categoryName || 'Found item'} found and held by a Return4me agent`,
                      `${categoryName || 'Bidhaa iliyopatikana'} iliyopatikana na kushikiliwa na wakala wa Return4me`
                    )}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-brand-muted-text bg-brand-light-gray px-4 text-center">
                    <Lock size={28} aria-hidden="true" className="mb-2" />
                    <span className="text-xs font-bold leading-relaxed">
                      {item.is_sensitive_document
                        ? t('Photo hidden for privacy', 'Picha imefichwa kwa faragha')
                        : t('No photo available', 'Hakuna picha')}
                    </span>
                  </div>
                )}
              </div>

              {/* Identity + recognition clues */}
              <div className="p-5 sm:p-6 flex flex-col">
                <p className="text-caption font-extrabold uppercase tracking-widest text-brand-muted-text">
                  {t('Found item', 'Bidhaa iliyopatikana')}
                </p>
                <h1 className="mt-1 text-xl sm:text-2xl font-bold text-brand-dark-text">
                  {categoryName || item.document_name_fuzzy}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge variant="info" icon={ShieldCheck}>
                    {item.status === 'at_agent'
                      ? t('Held by an agent', 'Inashikiliwa na wakala')
                      : t('Found', 'Imepatikana')}
                  </Badge>
                  <span className="text-caption font-semibold text-brand-muted-text">
                    {item.document_name_fuzzy}
                  </span>
                </div>

                <dl className="mt-4 space-y-2 text-xs">
                  <div className="flex items-start gap-2">
                    <dt className="sr-only">{t('General area', 'Eneo kwa ujumla')}</dt>
                    <MapPin size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />
                    <dd className="text-brand-muted-text leading-relaxed break-words">
                      {item.location_description || t('Location not published', 'Mahali hakujachapishwa')}
                    </dd>
                  </div>
                  {item.agent?.business_name && (
                    <div className="flex items-start gap-2">
                      <dt className="sr-only">{t('Held at', 'Inashikiliwa')}</dt>
                      <Package size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />
                      <dd className="text-brand-muted-text leading-relaxed break-words">
                        {item.agent.business_name}
                        {item.agent.rough_area ? ` · ${item.agent.rough_area}` : ''}
                      </dd>
                    </div>
                  )}
                  <div className="flex items-start gap-2">
                    <dt className="sr-only">{t('Reference and date recorded', 'Kumbukumbu na tarehe')}</dt>
                    <Lock size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-orange" />
                    <dd className="text-brand-muted-text leading-relaxed">
                      {t('Reference', 'Kumbukumbu')}:{' '}
                      <span className="font-mono">
                        {String(item.id || '').substring(0, 8).toUpperCase()}
                      </span>
                      {item.created_at
                        ? ` · ${new Date(item.created_at).toLocaleDateString(sw ? 'sw-KE' : 'en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}`
                        : ''}
                    </dd>
                  </div>
                </dl>

                {!item.is_sensitive_document && item.description && (
                  <p className="mt-4 text-xs text-brand-dark-text leading-relaxed line-clamp-4">
                    {item.description}
                  </p>
                )}

                <div className="mt-auto pt-5">
                  <Button
                    variant="accent"
                    size="lg"
                    className="w-full"
                    loading={claimBusy}
                    loadingLabel={t('Checking your session…', 'Inaangalia kipindi chako…')}
                    onClick={handleClaimClick}
                  >
                    {t("It's Mine", 'Ni Yangu')}
                  </Button>
                  <p className="mt-2 text-caption text-brand-muted-text leading-relaxed">
                    {t(
                      'You will be asked to sign in or create an account, then continue the ownership claim. A claim still requires identity verification and a physical handover through an agent.',
                      'Utatakiwa kuingia au kufungua akaunti, kisha uendelee kudai umiliki. Dai bado linahitaji uthibitisho wa utambulisho na kukabidhiwa ana kwa ana kupitia wakala.'
                    )}
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t border-brand-border bg-brand-beige px-5 sm:px-6 py-3">
              <p className="text-caption text-brand-muted-text leading-relaxed">
                {t(
                  'Return4me never publishes full names, document numbers, or a finder’s contact details. Exact ownership evidence is collected only inside the private claim process.',
                  'Return4me haichapishi majina kamili, namba za hati, wala mawasiliano ya aliyekipata. Ushahidi kamili wa umiliki hukusanywa tu ndani ya mchakato wa faragha wa kudai.'
                )}
              </p>
            </div>
          </article>
        )}
      </div>
    </div>
  );
}
