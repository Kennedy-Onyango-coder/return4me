import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, Loader2, Lock, Package, ShieldCheck } from 'lucide-react';
// UX-06 — the shared foundation, imported through the design-system barrel the
// same way every other migrated surface imports it (never an individual ui
// file), with icons sized from the shared ICON_SIZE ladder.
import { Badge, Button, ICON_SIZE, SectionHeading } from './ui';

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
// The ownership verification inside the claim flow (security answers + the
// phone/claim match + a one-time code emailed to the owner's verified address)
// is unchanged and remains the thing that actually proves ownership.
//
// UX-06 — PRESENTATION ONLY. This batch set the page's information hierarchy:
//   1. return to discovery   2. item image (or its deliberate absence)
//   3. item name + status    4. where it was found   5. when it was found
//   6. what helps an owner recognise it   7. one primary claim action
//   8. why some details stay private
// It moved the surface onto the UX-01 typography/radius/icon/appearance ladders
// and the shared primitives, and it made the ONE polite live region announce
// every state instead of only the first one. The data contract is untouched:
// the page still renders ONLY the fields services/publicItemView.ts publishes,
// and the "It's Mine" session gate, the request it makes and the claim hand-off
// it performs are the same code as before.

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

  // The live category list is the ONLY source of a human-readable item name
  // (P14A / P14-09): a category the list cannot resolve is honestly shown as
  // the id itself, never as a hard-coded brand label.
  const categoryName = (() => {
    const cat = categories.find((c: any) => c.id === item?.category_id);
    return cat ? (sw ? cat.name_sw : cat.name_en) : '';
  })();

  // The item's title. The discovery card the visitor arrived from titles the
  // item with the same live category name, so the detail page continues that
  // identity rather than inventing a second one.
  const itemTitle = categoryName || item?.category_id || item?.document_name_fuzzy || '';

  // Screen readers announce document.title as the primary "the page changed"
  // signal; App owns the base title, so restore it on the way out.
  useEffect(() => {
    const previous = document.title;
    const label = itemTitle ? ` — ${itemTitle}` : '';
    document.title = t(
      `Found item${label} | Return4me`,
      `Bidhaa iliyopatikana${label} | Return4me`
    );
    return () => {
      document.title = previous;
    };
  }, [itemTitle, lang]);

  // ---------------------------------------------------------------------------
  // Derived display values. Every one of them reads a field the public DTO
  // (services/publicItemView.ts) already publishes — nothing here re-derives,
  // re-parses or re-classifies item data, and nothing reads a private field.
  // ---------------------------------------------------------------------------

  // WHERE it was found: the canonical county, the structured sub-county the
  // public DTO names, and the coarse public area. Parts the item does not have
  // are dropped rather than rendered as an empty separator, and an item with no
  // location at all simply has no location row.
  const locationLine = [item?.found_county, item?.administrative_unit_name, item?.location_description]
    .filter((part: any) => typeof part === 'string' && part.trim().length > 0)
    .join(' · ');

  // WHEN it was found: created_at is the only date the public read model
  // publishes, and it is the same value the owner-facing match card shows as
  // the approximate found date (services/lostReportMatchView.ts -> found_at).
  const foundDate = item?.created_at
    ? new Date(item.created_at).toLocaleDateString(sw ? 'sw-KE' : 'en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '';

  // WHAT helps an owner recognise it. A sensitive document's description is
  // withheld by the server before this component ever sees it, so a missing
  // value renders nothing — never a placeholder standing in for data.
  const identifyingDetails = typeof item?.description === 'string' ? item.description.trim() : '';

  // WHERE it is being held: the hub's business name and the coarse area the
  // public DTO reduces the hub's address to. Its phone, exact address and
  // coordinates are not part of this shape and are never requested here.
  const heldAtLine = [item?.agent?.business_name, item?.agent?.rough_area]
    .filter((part: any) => typeof part === 'string' && part.trim().length > 0)
    .join(' · ');

  // The item's own public reference. This is NOT an internal identifier: it is
  // the id in the /item/<id> URL the visitor is already on, and the same mono
  // chip the public discovery card shows.
  const reference = String(item?.id || '')
    .slice(0, 8)
    .toUpperCase();

  // The established status vocabulary, unchanged. The public read model only
  // ever serves an item that is claimable (status 'at_agent'), so anything else
  // falls back to the same word the discovery card uses for a found item.
  const statusLabel =
    item?.status === 'at_agent' ? t('Held by an agent', 'Inashikiliwa na wakala') : t('Found', 'Imepatikana');

  // The view's ONE polite live region (publicExperience pins exactly one
  // aria-live in this file). It announces the state the page is in, so a
  // loading -> result transition is not silent for a screen reader. The error
  // branch deliberately contributes nothing here: it announces itself through
  // role="alert" on its own panel.
  const stateAnnouncement =
    state === 'loading'
      ? t('Loading this found item…', 'Inapakia bidhaa hii iliyopatikana…')
      : state === 'not_found'
        ? t('Item not found', 'Bidhaa haipatikani')
        : state === 'ready'
          ? t('Found item loaded', 'Bidhaa imepakiwa')
          : '';

  // One label and one value treatment for every fact row, so a fact's label can
  // never out-shout the item's own identity, and the 12px caption floor is
  // declared in exactly one place.
  const factLabelClass = 'text-caption font-bold uppercase tracking-wider text-[var(--appearance-text-muted)]';
  const factValueClass = 'mt-1 break-words text-body-large leading-relaxed text-[var(--appearance-text-primary)]';

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

  // Return to discovery. A real anchor to the homepage (which is where the
  // found-item discovery section lives), so open-in-new-tab and keyboard
  // activation behave the way a visitor expects, while `onBack` performs the
  // same navigation inside the SPA. Visually subordinate to the item itself,
  // and its only keyboard indicator is the single global :focus-visible rule
  // (UX-01) — it used to stack its own outline-none + ring on top of it.
  const backLink = (
    <a
      href="/"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onBack();
      }}
      className="inline-flex min-h-11 items-center gap-2 text-small font-bold text-[var(--appearance-primary)] hover:underline"
    >
      <ArrowLeft size={ICON_SIZE.ui} aria-hidden="true" />
      {/* BATCH 4 — WORDING ONLY. The handler and destination are untouched:
          this link has always returned to the HOMEPAGE (onBack ->
          navigate('/', 'home')), and it is not being given a return-to-results
          behaviour in this batch. Only the visible label changed, so it now
          describes the destination it actually has. */}
      {t('Back to home', 'Rudi nyumbani')}
    </a>
  );

  return (
    <div className="w-full flex-grow bg-[var(--appearance-background)] px-5 sm:px-12 py-8 sm:py-12">
      <div className="mx-auto max-w-5xl">
        {backLink}

        {/* The view's single polite live region. It is mounted for the whole
            life of the page and its text follows the state, so "loading" and
            the result that replaces it are both announced; the region is
            visually hidden because the visible panels below already carry the
            same message for sighted visitors. */}
        <div className="sr-only" role="status" aria-live="polite">
          {stateAnnouncement}
        </div>

        {state === 'loading' && (
          <div className="mt-6 flex flex-col items-center justify-center gap-3 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-6 py-16 text-center">
            <Loader2
              size={ICON_SIZE.feature}
              aria-hidden="true"
              className="animate-spin text-[var(--appearance-primary)]"
            />
            <p className="text-body text-[var(--appearance-text-muted)]">
              {t('Loading this found item…', 'Inapakia bidhaa hii iliyopatikana…')}
            </p>
          </div>
        )}

        {state === 'not_found' && (
          <div className="mt-6 flex flex-col items-center gap-3 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-6 py-14 text-center">
            <Package size={ICON_SIZE.feature} aria-hidden="true" className="text-[var(--appearance-text-muted)]" />
            <h1 className="text-section font-extrabold tracking-tight text-[var(--appearance-text-primary)]">
              {t('Item not found', 'Bidhaa haipatikani')}
            </h1>
            <p className="max-w-md text-body leading-relaxed text-[var(--appearance-text-muted)]">
              {t(
                'This item may no longer be publicly available. It may have been claimed, withdrawn, or the link may be incorrect.',
                'Bidhaa hii huenda haipatikani kwa umma tena. Inawezekana ilidaiwa, iliondolewa, au kiungo si sahihi.'
              )}
            </p>
            <div className="mt-2">
              <Button variant="primary" size="md" onClick={onBack}>
                {t('Browse found items', 'Angalia vitu vilivyopatikana')}
              </Button>
            </div>
          </div>
        )}

        {state === 'error' && (
          <div
            role="alert"
            className="mt-6 flex flex-col items-center gap-3 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-6 py-14 text-center"
          >
            <AlertCircle
              size={ICON_SIZE.feature}
              aria-hidden="true"
              className="text-[var(--appearance-danger)]"
            />
            <h1 className="text-section font-extrabold tracking-tight text-[var(--appearance-text-primary)]">
              {t('We could not load this item', 'Hatukuweza kupakia bidhaa hii')}
            </h1>
            <p className="max-w-md text-body leading-relaxed text-[var(--appearance-text-muted)]">
              {t(
                'Something went wrong on our side. Please try again.',
                'Kuna hitilafu upande wetu. Tafadhali jaribu tena.'
              )}
            </p>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
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
          <>
            <article className="mt-6 overflow-hidden rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] shadow-raised">
              <div className="grid grid-cols-1 md:grid-cols-2">
                {/* Media — a sensitive document's photo is never sent by the API,
                    so the "hidden" panel below is a server-enforced fact, not a
                    client-side choice. */}
                <div className="relative aspect-[4/3] bg-[var(--appearance-surface-muted)] md:aspect-auto md:min-h-64">
                  {item.photo_url ? (
                    <img
                      src={item.photo_url}
                      alt={t(
                        `${itemTitle || 'Found item'} found and held by a Return4me agent`,
                        `${itemTitle || 'Bidhaa iliyopatikana'} iliyopatikana na kushikiliwa na wakala wa Return4me`
                      )}
                      loading="lazy"
                      decoding="async"
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[var(--appearance-text-muted)]">
                      {item.is_sensitive_document ? (
                        <>
                          <Lock size={ICON_SIZE.feature} aria-hidden="true" />
                          <p className="text-small font-bold">
                            {t('Photo hidden for privacy', 'Picha imefichwa kwa faragha')}
                          </p>
                          <p className="max-w-xs text-caption leading-relaxed">
                            {t(
                              'This is a sensitive document, so its photograph is never published.',
                              'Hii ni hati nyeti, kwa hivyo picha yake haichapishwi kamwe.'
                            )}
                          </p>
                        </>
                      ) : (
                        <>
                          <Package size={ICON_SIZE.feature} aria-hidden="true" />
                          <p className="text-small font-bold">
                            {t('No photo available', 'Hakuna picha')}
                          </p>
                          <p className="max-w-xs text-caption leading-relaxed">
                            {t(
                              'The finder reported this item without a photograph, so the details below are the only way to recognise it.',
                              'Aliyekipata aliripoti bidhaa hii bila picha, kwa hivyo maelezo yaliyo hapa chini ni njia pekee ya kuitambua.'
                            )}
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Identity: the item's name, its public status and its own
                    public reference — nothing an owner would have to guess. */}
                <div className="flex flex-col p-5 sm:p-8">
                  <p className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]">
                    {t('Found item', 'Bidhaa iliyopatikana')}
                  </p>
                  <h1 className="mt-2 text-section font-extrabold tracking-tight text-[var(--appearance-text-primary)] sm:text-page">
                    {itemTitle}
                  </h1>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Badge variant="info" icon={ShieldCheck}>
                      {statusLabel}
                    </Badge>
                    {reference ? (
                      <span className="inline-flex items-center rounded-compact border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] px-2 py-1 font-mono text-caption tracking-wide text-[var(--appearance-text-primary)]">
                        <span className="sr-only">{t('Reference', 'Kumbukumbu')}</span>
                        {reference}
                      </span>
                    ) : null}
                  </div>

                  <dl className="mt-6 space-y-4">
                    {/* PHASE 16.1 (GEO-16-03): the canonical county is one part of
                        this line — the coarsest geography the product models. No
                        coordinate, distance, ward or address detail is derived
                        here, and an item with no location simply has no row. */}
                    {locationLine ? (
                      <div>
                        <dt className={factLabelClass}>{t('Found location', 'Mahali ilipopatikana')}</dt>
                        <dd className={factValueClass}>{locationLine}</dd>
                      </div>
                    ) : null}

                    {foundDate ? (
                      <div>
                        <dt className={factLabelClass}>{t('Found date', 'Tarehe ilipopatikana')}</dt>
                        <dd className={factValueClass}>{foundDate}</dd>
                      </div>
                    ) : null}

                    {identifyingDetails ? (
                      <div>
                        <dt className={factLabelClass}>{t('Identifying details', 'Maelezo ya kutambua')}</dt>
                        <dd className={factValueClass}>{identifyingDetails}</dd>
                      </div>
                    ) : null}

                    {heldAtLine ? (
                      <div>
                        <dt className={factLabelClass}>{t('Held at', 'Inashikiliwa')}</dt>
                        <dd className={factValueClass}>{heldAtLine}</dd>
                      </div>
                    ) : null}
                  </dl>

                  {/* ONE primary action: the existing "It's Mine" entry into the
                      ownership claim. 52px tall, the full width of the details
                      column, and the same session-gated handler as before. */}
                  <div className="mt-auto pt-8">
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
                    <p className="mt-3 text-caption leading-relaxed text-[var(--appearance-text-muted)]">
                      {t(
                        'You will be asked to sign in or create an account, then continue the ownership claim. A claim still requires identity verification and a physical handover through an agent.',
                        'Utatakiwa kuingia au kufungua akaunti, kisha uendelee kudai umiliki. Dai bado linahitaji uthibitisho wa utambulisho na kukabidhiwa ana kwa ana kupitia wakala.'
                      )}
                    </p>
                  </div>
                </div>
              </div>
            </article>

            {/* Why some details stay private. Customer language only — no
                escrow, API, database or verification-architecture vocabulary —
                and it supports the ownership check the claim flow performs
                rather than describing how that check is implemented. */}
            <section
              aria-labelledby="item-privacy-heading"
              className="mt-6 rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] p-5 sm:p-6"
            >
              <SectionHeading
                titleId="item-privacy-heading"
                title={t('Why some details stay private', 'Kwa nini baadhi ya maelezo hayachapishwi')}
                description={t(
                  'Anyone can open this page, so it shows only what helps the rightful owner recognise the item. Full names, document numbers and a finder’s contact details are never published, and proof of ownership is collected only inside the private claim process.',
                  'Mtu yeyote anaweza kufungua ukurasa huu, kwa hivyo unaonyesha tu yale yanayomsaidia mmiliki halisi kutambua bidhaa. Majina kamili, namba za hati na mawasiliano ya aliyekipata hayachapishwi kamwe, na uthibitisho wa umiliki hukusanywa tu ndani ya mchakato wa faragha wa kudai.'
                )}
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
