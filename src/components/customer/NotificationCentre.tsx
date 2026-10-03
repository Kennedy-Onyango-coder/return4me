import React, { useCallback, useEffect, useState } from 'react';
import { Bell, ChevronDown, History, Loader2 } from 'lucide-react';
import { Badge, Banner, Button, EmptyState, SectionHeading } from '../ui';
import {
  categoryLabel,
  groupNotifications,
  stateLabel,
  type CustomerNotificationGroupBucket,
  type CustomerNotificationState,
} from '../../config/customerNotifications';
import {
  getMyPreferences,
  listMyNotificationHistory,
  listMyNotifications,
  openMyNotification,
  setMyPreference,
  type CustomerNotification,
} from '../../services/customerNotificationsApi';

// ===========================================================================
// BATCH 1 - NOTIFICATION CENTRE (customer).
//
// Active notifications, Notification History, read state and preferences in one
// customer-facing surface.
//
// WHAT THIS COMPONENT IS NOT
//   It is NOT a source of truth and makes no business decision. Every state it
//   renders (action_required, pending, completed, expired) was DERIVED
//   SERVER-SIDE from the authoritative claim/payment/report row at read time
//   (services/customerNotifications.ts). This file only displays those states
//   and omits an action the server said is no longer valid.
//
// READ STATE IS SERVER STATE
//   Opening a notification is what marks it read, via the API. Nothing is kept in
//   the browser, because a local copy is exactly what makes a badge disagree with
//   the truth on the next device. The unread count comes from the SAME response as
//   the list, so the badge and the rows cannot contradict each other.
//
// NO PROVIDER INTERNALS
//   Only fields the API exposes are rendered. There is no delivery status, retry
//   count, provider name or error string to render, because the API does not
//   return them (asserted in batch1NotificationRoutesHttp.test.ts).
//
// ACCESSIBILITY
//   The unread count lives in a real button's accessible name so it is announced
//   rather than only drawn; the tabs are a proper tablist; disclosure uses a real
//   <details>/<summary>; and the lists are real <ul>/<li> so a screen reader
//   announces item counts.
// ===========================================================================
//

interface Props {
  lang: 'en' | 'sw';
}

const STATE_TONE: Record<CustomerNotificationState, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  informational: 'info',
  action_required: 'warning',
  pending: 'neutral',
  completed: 'success',
  expired: 'neutral',
};

type Tab = 'active' | 'history';

export default function NotificationCentre({ lang }: Props) {
  const [tab, setTab] = useState<Tab>('active');
  const [items, setItems] = useState<CustomerNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPreferences, setShowPreferences] = useState(false);
  const [prefs, setPrefs] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Two branches kept explicit rather than merged: the ACTIVE endpoint also
      // returns the unread count, and reading it from the SAME response is what
      // guarantees the badge and the rows can never disagree.
      if (tab === 'active') {
        const active = await listMyNotifications();
        setItems(active.notifications);
        setUnread(active.unread);
      } else {
        const history = await listMyNotificationHistory();
        setItems(history.notifications);
      }
    } catch {
      // Neutral wording: the customer is told what happened in service terms and
      // never what failed underneath.
      setError(
        lang === 'sw'
          ? 'Hatumeweza kupata taarifa zako. Tafadhali jaribu tena baadaye.'
          : "We couldn't load your notifications. Please try again shortly.",
      );
    } finally {
      setLoading(false);
    }
  }, [tab, lang]);

  useEffect(() => {
    void load();
  }, [load]);

  // Opening marks the notification read. The list is then RE-READ from the server
  // rather than patched locally, so what is displayed is always what the server
  // believes, including any state that changed in the meantime.
  const open = useCallback(
    async (notification: CustomerNotification) => {
      try {
        const opened = await openMyNotification(notification.id);
        if (opened.actionPath) {
          window.location.assign(opened.actionPath);
          return;
        }
      } catch {
        // Fall through: the refresh below still reflects the truth.
      }
      await load();
    },
    [load],
  );

  useEffect(() => {
    if (!showPreferences) return;
    void (async () => {
      try {
        setPrefs(await getMyPreferences());
      } catch {
        setPrefs([]);
      }
    })();
  }, [showPreferences]);

  const changePref = useCallback(
    async (category: string, channel: string, enabled: boolean) => {
      try {
        const result = await setMyPreference(category, channel, enabled);
        setPrefs(result.preferences);
        // A refusal is confirmed to the customer rather than silently swallowed:
        // the server decided this from the category, and the customer is told.
        setNotice(
          result.applied
            ? lang === 'sw'
              ? 'Mabadiliko yamehifadhiwa.'
              : 'Your preference has been saved.'
            : result.reason ||
              (lang === 'sw'
                ? 'Huwezi kubadilisha taarifa hii.'
                : 'This notification cannot be changed.'),
        );
      } catch {
        setNotice(
          lang === 'sw' ? 'Mabadiliko hayakuweza kuhifadhiwa.' : 'Your preference could not be saved.',
        );
      }
    },
    [lang],
  );

  // Grouping is a PRESENTATION transform only. Every notification still renders,
  // and History is unaffected by it.
  const entries = groupNotifications(
    items.map((n) => ({ ...n, businessReference: n.reference })),
  );

  const renderItem = (n: CustomerNotification, key: string) => (
    <li key={key} className="py-3 border-b border-slate-100 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {!n.read && (
              <span
                aria-label={lang === 'sw' ? 'Haisomwi' : 'Unread'}
                className="inline-block h-2 w-2 rounded-full bg-amber-500 shrink-0"
              />
            )}
            <span className={n.read ? 'font-medium text-slate-600' : 'font-medium text-slate-900'}>
              {n.title}
            </span>
          </div>
          {n.body && <p className="text-sm text-slate-600 mt-1">{n.body}</p>}
          <p className="text-xs text-slate-500 mt-1">
            {categoryLabel(n.category, lang)} | {new Date(n.createdAt).toLocaleString(lang)}
            {n.reference ? ' | ' + n.reference : ''}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <Badge variant={STATE_TONE[n.state]}>{stateLabel(n.state, lang)}</Badge>
          {/* The action renders ONLY when the server says it is still valid, and
              is absent entirely for expired and completed notifications. */}
          {n.actionAvailable && n.actionPath ? (
            <Button size="sm" onClick={() => void open(n)}>
              {lang === 'sw' ? 'Fanya hatua' : 'Take action'}
            </Button>
          ) : null}
          {!n.read && !n.actionAvailable ? (
            <Button size="sm" variant="ghost" onClick={() => void open(n)}>
              {lang === 'sw' ? 'Fungua' : 'Open'}
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );

  return (
    <section aria-label={lang === 'sw' ? 'Taarifa' : 'Notifications'} className="space-y-4">
      <SectionHeading
        title={lang === 'sw' ? 'Taarifa' : 'Notifications'}
        description={
          unread > 0
            ? lang === 'sw'
              ? 'Una taarifa hazijasomwa: ' + unread
              : 'You have ' + unread + ' unread notification' + (unread === 1 ? '' : 's') + '.'
            : undefined
        }
      />

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={showPreferences ? 'primary' : 'secondary'}
          onClick={() => setShowPreferences((v) => !v)}
          aria-expanded={showPreferences}
          aria-label={
            unread > 0
              ? lang === 'sw'
                ? 'Mipangilio ya taarifa, hazijasomwa ' + unread
                : 'Notification preferences, ' + unread + ' unread'
              : lang === 'sw'
                ? 'Mipangilio ya taarifa'
                : 'Notification preferences'
          }
        >
          <Bell aria-hidden="true" />
          {unread > 0 ? <span className="ml-1">{unread}</span> : null}
        </Button>
      </div>

      {notice ? (
        <Banner kind="info" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      ) : null}
      {error ? <Banner kind="error">{error}</Banner> : null}

      {showPreferences ? (
        <div className="rounded-lg border border-slate-200 p-4 space-y-3">
          <h3 className="font-medium text-slate-900">
            {lang === 'sw' ? 'Mipangilio ya taarifa' : 'Notification preferences'}
          </h3>
          <ul className="space-y-2">
            {prefs.map((p) => (
              <li key={p.category} className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-sm text-slate-800">{categoryLabel(p.category, lang)}</span>
                  {p.essential ? (
                    <span className="ml-2 text-xs text-slate-500">
                      {lang === 'sw' ? 'Inahitajika' : 'Required'}
                    </span>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  {p.channels.map((c: any) => (
                    <Button
                      key={c.channel}
                      size="sm"
                      variant={c.enabled ? 'primary' : 'secondary'}
                      // Non-configurable channels render DISABLED rather than
                      // hidden: the customer can see the setting exists and why
                      // it cannot move. Disabling is re-enforced server-side too.
                      disabled={!c.configurable}
                      aria-label={categoryLabel(p.category, lang) + ' - ' + c.channel}
                      onClick={() => void changePref(p.category, c.channel, !c.enabled)}
                    >
                      {c.channel === 'in_app'
                        ? lang === 'sw'
                          ? 'Ndani ya programu'
                          : 'In app'
                        : c.channel.toUpperCase()}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div role="tablist" aria-label={lang === 'sw' ? 'Mwonekano' : 'View'} className="flex gap-2">
        <Button
          size="sm"
          variant={tab === 'active' ? 'primary' : 'secondary'}
          role="tab"
          aria-selected={tab === 'active'}
          onClick={() => setTab('active')}
        >
          <Bell aria-hidden="true" />
          {lang === 'sw' ? 'Za sasa' : 'Active'}
        </Button>
        <Button
          size="sm"
          variant={tab === 'history' ? 'primary' : 'secondary'}
          role="tab"
          aria-selected={tab === 'history'}
          onClick={() => setTab('history')}
        >
          <History aria-hidden="true" />
          {lang === 'sw' ? 'Historia' : 'History'}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-slate-500" role="status" aria-live="polite">
          <Loader2 aria-hidden="true" />
          {lang === 'sw' ? 'Inapakia...' : 'Loading...'}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={tab === 'active' ? Bell : History}
          title={
            tab === 'active'
              ? lang === 'sw'
                ? 'Hakuna taarifa mpya'
                : 'No new notifications'
              : lang === 'sw'
                ? 'Hakuna historia bado'
                : 'No history yet'
          }
          description={
            tab === 'active'
              ? lang === 'sw'
                ? 'Tutakuonyesha hapa pale kuna jambo unayohitaji kujua.'
                : "We'll let you know here when there's something you need to know about."
              : lang === 'sw'
                ? 'Taarifa zako zilizopita zitaonekana hapa.'
                : 'Your past notifications will appear here.'
          }
        />
      ) : (
        <ul>
          {entries.map((entry: any) => {
            if (entry.notifications) {
              const bucket = entry as CustomerNotificationGroupBucket<any>;
              return (
                <li key={bucket.key} className="py-2">
                  <details>
                    <summary className="cursor-pointer text-sm text-slate-700 flex items-center gap-2">
                      <ChevronDown aria-hidden="true" />
                      {categoryLabel(bucket.notifications[0].category, lang)} | {bucket.reference} (
                      {bucket.notifications.length})
                    </summary>
                    <ul>{bucket.notifications.map((n: CustomerNotification) => renderItem(n, n.id))}</ul>
                  </details>
                </li>
              );
            }
            return renderItem(entry as CustomerNotification, entry.id);
          })}
        </ul>
      )}
    </section>
  );
}
