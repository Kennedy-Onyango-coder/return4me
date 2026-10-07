import { Resend } from 'resend';
import { getAdminNotificationEmail } from '../config/adminNotificationEmail.ts';
import {
  isConfiguredResendApiKey,
  resolveEmailFrom,
  resolveEmailReplyTo,
} from '../config/emailConfig.ts';
import {
  EMAIL_THEME,
  buildEmailMessage,
  emailButton,
  emailCallout,
  emailCodeBlock,
  emailDetails,
  emailDivider,
  emailHeading,
  emailKicker,
  emailList,
  emailNote,
  emailParagraph,
  escapeHtml,
  htmlToPlainText,
} from './emailTemplates.ts';

let resendInstance: Resend | null = null;

/**
 * Upper bound on a single Resend HTTP round-trip.
 *
 * A provider that accepts the connection and then never answers would otherwise
 * pin the request (and its worker) indefinitely. A timeout here is deliberately
 * AMBIGUOUS: `sendWithId`'s catch cannot tell whether the request was accepted
 * before the connection stalled, so it must not record a clean failure. Bounded
 * so an unresponsive provider cannot stall the request path; overridable for
 * tests via EMAIL_PROVIDER_TIMEOUT_MS.
 */
const EMAIL_PROVIDER_TIMEOUT_MS = (() => {
  const raw = Number(process.env.EMAIL_PROVIDER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();

/**
 * Reject if `operation` has not settled within EMAIL_PROVIDER_TIMEOUT_MS.
 *
 * A race rather than an AbortSignal on purpose: the Resend SDK's request-options
 * type exposes no signal, so this bounds the WAIT without depending on SDK
 * internals. The `finally` clears the timer so a fast provider leaks nothing.
 */
function withProviderTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not respond within ${EMAIL_PROVIDER_TIMEOUT_MS}ms`)),
      EMAIL_PROVIDER_TIMEOUT_MS,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * The process's single Resend client.
 *
 * The "is this key usable" decision is NOT made here: it lives in
 * `config/emailConfig.ts` and is shared with the production boot guard, so a
 * deployment can never be validated against one rule and then send against a
 * different one. A PLACEHOLDER key counts as absent — `.env.example` ships
 * `RESEND_API_KEY="REPLACE_WITH_RESEND_API_KEY"`, and the previous check here
 * accepted that, constructed a real SDK client and issued a real outbound HTTPS
 * request carrying a fake credential.
 */
function getResendClient(): Resend | null {
  if (resendInstance) return resendInstance;

  const apiKey = process.env.RESEND_API_KEY;
  if (!isConfiguredResendApiKey(apiKey)) {
    return null;
  }

  try {
    resendInstance = new Resend(String(apiKey).trim());
    return resendInstance;
  } catch (error) {
    console.error('[EMAIL SERVICE] Failed to initialize Resend client:', error);
    return null;
  }
}


// ===========================================================================
// N8 — TRANSACTIONAL EMAIL TEMPLATES (the PURE half of the email path).
//
// Every builder below: builds a subject and an HTML body, sends nothing,
// reaches no provider and reads no configuration. That purity is what makes
// them safe to call from `NotificationService.render()`, which evaluates the
// template transiently at dispatch time and then discards the result.
//
// A body may legitimately contain a sensitive value (a secret pickup code, the
// owner's phone number) — which is exactly why the rendered body MUST stay
// transient: the durable notification row stores the event, the recipient's
// hashed reference and the provider message id, and never the body.
//
// The markup is no longer written inline here. Each template composes the
// shared blocks in `./emailTemplates.ts` (one branded document shell, receipt
// tables, code blocks, callouts, the English/Kiswahili divider), so:
//
//   - all six messages share ONE shell, ONE palette and ONE footer, instead of
//     six hand-copied `#003820`-on-white documents that drifted apart;
//   - every interpolated value goes through the shared escaping helpers;
//   - the `text/plain` alternative is derived from this very HTML by the
//     transport, so the two parts of a multipart message cannot disagree.
//
// The return shape is unchanged (`{ subject, body }`) and the subjects are
// byte-identical to the pre-migration ones: a recipient sees the same subject,
// the same facts and the same code as before, in both languages.
// ===========================================================================

/**
 * Payment received by the owner of a claimed item (N8, EventType
 * PAYMENT_RECEIVED).
 *
 * Carries the two things physical pickup depends on: the SECRET PICKUP CODE the
 * owner reads to the agent, and the agent's phone number. `to` and `ownerPhone`
 * are part of the notification contract (the recipient and the number the
 * owner's account is verified with) and are restated in the body so the owner
 * can confirm the message is really about them.
 */
export function renderSendPaymentReceivedEmail(
    to: string,
    ownerPhone: string,
    itemName: string,
    agentBusinessName: string,
    agentPhone: string,
    itemReference: string,
    pickupCode: string
): { subject: string; body: string } {
    const subject = 'Payment Confirmed / Malipo Imethibitishwa - Return4me';

    const content = [
        emailKicker('Claim payment verified'),
        emailHeading('Your payment is confirmed - the item is held for you'),
        emailParagraph(
            `Your claim payment has been received and verified. <strong>${escapeHtml(itemName)}</strong> is being held for you at the agent point below.`
        ),
        emailDetails([
            { label: 'Item', value: itemName },
            { label: 'Collection point', value: agentBusinessName },
            { label: 'Agent phone', value: agentPhone, mono: true },
            { label: 'Item reference', value: itemReference, mono: true },
            { label: 'Your verified number', value: ownerPhone, mono: true },
        ]),
        emailCodeBlock({
            label: 'Secret pickup code',
            code: pickupCode,
            tone: 'success',
            hint: 'Read this code to the agent only when you are standing at the counter. It is single use: once the agent enters it, the handover is recorded.',
        }),
        emailCallout({
            tone: 'warning',
            label: 'Keep this code private',
            text: 'This secret pickup code is <strong>not</strong> the item reference above. Return4me never asks for it by phone call, SMS or social media, and no agent should ask for it before you are physically at the collection point.',
        }),
        emailNote('Keep this email until you have collected the item. If the agent cannot find your claim, quote the item reference above.'),
        emailDivider('Kiswahili'),
        emailHeading('Malipo yamethibitishwa - bidhaa yako inahifadhiwa'),
        emailParagraph(
            `Malipo ya dai lako yamepokelewa na kuthibitishwa. <strong>${escapeHtml(itemName)}</strong> inahifadhiwa kwa ajili yako katika kituo cha wakala kilicho hapa chini hadi utakapofika kuichukua.`
        ),
        emailDetails([
            { label: 'Bidhaa', value: itemName },
            { label: 'Kituo cha kuchukulia', value: agentBusinessName },
            { label: 'Simu ya wakala', value: agentPhone, mono: true },
            { label: 'Nambari ya rejea', value: itemReference, mono: true },
            { label: 'Nambari yako iliyothibitishwa', value: ownerPhone, mono: true },
        ]),
        emailCodeBlock({
            label: 'Msimbo wa siri wa kuchukulia',
            code: pickupCode,
            tone: 'success',
            hint: 'Mpe wakala msimbo huu wakati umesimama kaunta. Unatumika mara moja tu.',
        }),
        emailCallout({
            tone: 'warning',
            label: 'Usishiriki msimbo huu',
            text: 'Msimbo huu wa siri si sawa na nambari ya rejea ya bidhaa. Return4me haitauliza msimbo huu kwa simu, SMS au mitandao ya kijamii, na wakala hapaswi kukuuliza kabla ya wewe kufika kituoni.',
        }),
    ].join('\n');

    const { html } = buildEmailMessage({
        subject,
        preheader: `Your payment is confirmed. Collect from ${agentBusinessName} with the secret pickup code below.`,
        headerLabel: 'Payment confirmed',
        accent: EMAIL_THEME.success,
        content,
        footerNote: `Item reference ${escapeHtml(itemReference)}. Keep this message: the secret pickup code in it is what releases the item.`,
    });

    return { subject, body: html };
}
/**
 * The item has been physically handed over to its owner (N8, EventType
 * ITEM_HANDED_OVER).
 *
 * This is the closure message: it restates the item code, the date and the
 * verified number the handover was recorded against, so the owner has a receipt
 * and support has something to look up if the handover is later disputed.
 */
export function renderSendItemHandedOverEmail(
    to: string,
    phone: string,
    itemName: string,
    dropoffCode: string,
    dateStr: string
): { subject: string; body: string } {
    const subject = 'Item Handed Over Successfully / Bidhaa Imekabidhiwa - Return4me';

    const content = [
        emailKicker('Handover recorded'),
        emailHeading('Item Handed Over Successfully!'),
        emailParagraph(
            `The item you claimed, <strong>${escapeHtml(itemName)}</strong>, has been handed over and the handover was recorded by the agent. Thank you for using Return4me.`
        ),
        emailDetails([
            { label: 'Item', value: itemName },
            { label: 'Item code', value: dropoffCode, mono: true },
            { label: 'Verified owner number', value: phone, mono: true },
            { label: 'Handover date', value: dateStr },
        ]),
        emailCallout({
            tone: 'success',
            label: 'Case closed',
            text: 'The claim on this item is now complete and the item can no longer be claimed by anyone else. Keep the item code above if you need to talk to support about it.',
        }),
        emailNote('If you did not receive this item in person, contact us immediately and quote the item code above.'),
        emailDivider('Kiswahili'),
        emailHeading('Bidhaa Imekabidhiwa kikamilifu!'),
        emailParagraph(
            `Bidhaa uliyodai, <strong>${escapeHtml(itemName)}</strong>, imekabidhiwa na wakala amerekodi makabidhiano hayo. Asante kwa kutumia Return4me.`
        ),
        emailDetails([
            { label: 'Bidhaa', value: itemName },
            { label: 'Nambari ya bidhaa', value: dropoffCode, mono: true },
            { label: 'Nambari ya mmiliki iliyothibitishwa', value: phone, mono: true },
            { label: 'Tarehe ya makabidhiano', value: dateStr },
        ]),
        emailCallout({
            tone: 'success',
            label: 'Dai limekamilika',
            text: 'Dai la bidhaa hii limekamilika na hakuna mtu mwingine anayeweza kuidai tena. Hifadhi nambari ya bidhaa hapo juu kama utahitaji kuwasiliana na huduma kwa wateja.',
        }),
        emailNote('Kama hukupokea bidhaa hii ana kwa ana, wasiliana nasi mara moja ukitaja nambari ya bidhaa hapo juu.'),
    ].join('\n');

    const { html } = buildEmailMessage({
        subject,
        preheader: `${itemName} was handed over on ${dateStr}. This email is your record of the handover.`,
        headerLabel: 'Handover recorded',
        accent: EMAIL_THEME.success,
        content,
        footerNote: `Recorded against item code ${escapeHtml(dropoffCode)}. Questions? Write to ${EMAIL_THEME.supportEmail}.`,
    });

    return { subject, body: html };
}

/**
 * INTERNAL alert: a found item was auto-assigned to a fallback agent (N8,
 * EventType ADMIN_REASSIGNMENT).
 *
 * Sent to the operations inbox, never to a customer. The point of the message is
 * that the automatic assignment is NOT a decision a human made, so it says so in
 * the body and in the subject line and links straight to the console where the
 * reassignment can be made.
 */
export function renderSendAdminNewReassignmentRequestEmail(
    dropoffCode: string,
    locationDescription: string,
    finderPhone: string
): { subject: string; body: string } {
    const subject = `[URGENT] Manual Agent Reassignment Needed - Dropoff Code ${dropoffCode}`;

    const content = [
        emailKicker('Admin action required'),
        emailHeading('Manual Reassignment Review Required'),
        emailParagraph(
            'A found item was assigned to an agent automatically and the assignment needs a human decision. The item is not lost, but it is not with a confirmed agent point either until someone reviews this.'
        ),
        emailDetails([
            { label: 'Dropoff code', value: dropoffCode, mono: true },
            { label: 'Reported location', value: locationDescription },
            { label: 'Finder phone', value: finderPhone, mono: true },
            { label: 'Assignment status', value: 'Fallback Agent Assigned' },
        ]),
        emailCallout({
            tone: 'danger',
            label: 'Fallback Agent Assigned',
            text: 'The fallback assignment is a placeholder, not an accepted handover. Reassign the item to a real agent point, or contact the finder directly, before it ages any further.',
        }),
        emailButton({
            href: `${EMAIL_THEME.siteUrl}/admin`,
            label: 'Open the admin dashboard',
            tone: 'danger',
            fallback: true,
        }),
        emailNote('This is an automated internal notification. Do not forward it outside operations.'),
    ].join('\n');

    const { html } = buildEmailMessage({
        subject,
        preheader: `Dropoff code ${dropoffCode} needs manual reassignment - a fallback agent was assigned automatically.`,
        headerLabel: 'Internal alert',
        accent: EMAIL_THEME.danger,
        content,
        footerNote: `Item ${escapeHtml(dropoffCode)}. Reassign or contact the finder from the admin dashboard.`,
    });

    return { subject, body: html };
}
/**
 * The agent holding a claimed item is authorized to release it (N8, EventType
 * AGENT_PAYMENT_CONFIRMED).
 *
 * The single operational instruction in this message is "do not release before
 * you have the owner's secret pickup code", so it is stated as a warning panel
 * and repeated as an ordered list of the three steps the agent takes at the
 * counter. `agentBusinessName` is the greeting; `dropoffCode` and `claimId` are
 * what the agent portal expects when recording the handover.
 */
export function renderSendAgentPaymentConfirmedEmail(
    to: string,
    agentBusinessName: string,
    itemName: string,
    dropoffCode: string,
    claimId: string
): { subject: string; body: string } {
    const subject = 'Payment Confirmed / Release Authorized - Return4me';

    const content = [
        emailKicker('Escrow settled'),
        emailHeading('Payment Received! Release Authorized'),
        emailParagraph(
            `Hello ${escapeHtml(agentBusinessName)}, we have received and verified the escrow payment for <strong>${escapeHtml(itemName)}</strong>, the item held at your point. You are now authorized to release it to the owner.`
        ),
        emailDetails([
            { label: 'Item', value: itemName },
            { label: 'Item code', value: dropoffCode, mono: true },
            { label: 'Claim ID', value: claimId, mono: true },
            { label: 'Release status', value: 'Authorized - awaiting collection' },
        ]),
        emailCallout({
            tone: 'warning',
            label: 'Do not release the item without the code',
            text: 'The owner has been sent a secret pickup code. Ask them for it, enter it in the agent portal, and release the item only when the portal accepts it. That code is the only proof of ownership at the counter.',
        }),
        emailList([
            'Ask the owner for their secret pickup code.',
            'Enter that code in the Agent Portal for this claim.',
            'Confirm the handover so the finder&#39;s reward can settle.',
        ]),
        emailNote('If the owner never collects the item, do not release it to anyone else. Report it to support and we will handle the next step.'),
        emailDivider('Kiswahili'),
        emailHeading('Malipo yamepokelewa! Umeruhusiwa kutoa bidhaa'),
        emailParagraph(
            `Habari ${escapeHtml(agentBusinessName)}, tumepokea na kuthibitisha malipo ya escrow kwa <strong>${escapeHtml(itemName)}</strong>, bidhaa inayohifadhiwa kwenye kituo chako. Umeruhusiwa kumpa mmiliki bidhaa hiyo.`
        ),
        emailDetails([
            { label: 'Bidhaa', value: itemName },
            { label: 'Nambari ya bidhaa', value: dropoffCode, mono: true },
            { label: 'Nambari ya dai', value: claimId, mono: true },
            { label: 'Hali ya uwasilishaji', value: 'Umeruhusiwa - inasubiri kuchukuliwa' },
        ]),
        emailCallout({
            tone: 'warning',
            label: 'Usitoe bidhaa bila msimbo',
            text: 'Mmiliki ametumiwa msimbo wa siri wa kuchukulia. Muulize msimbo huo, uuingize kwenye portal ya wakala, na umpe bidhaa tu pale portal inapokubali msimbo huo. Msimbo huo ndio uthibitisho pekee wa umiliki.',
        }),
        emailNote('Kama mmiliki hatakuja kuchukua bidhaa, usimpe mtu mwingine. Ripoti kwa Return4me na tutashughulikia hatua inayofuata.'),
    ].join('\n');

    const { html } = buildEmailMessage({
        subject,
        preheader: `Escrow settled for ${itemName}. Ask the owner for their secret pickup code before releasing it.`,
        headerLabel: 'Release authorized',
        accent: EMAIL_THEME.success,
        content,
        footerNote: `Claim ${escapeHtml(claimId)} / item ${escapeHtml(dropoffCode)}. Questions? Write to ${EMAIL_THEME.supportEmail}.`,
    });

    return { subject, body: html };
}
/**
 * Thank-you to the finder whose item was collected (N8, EventType
 * FINDER_ITEM_COLLECTED).
 *
 * The finder's reward is paid out by M-Pesa, so the message is explicit both
 * about what happened and about where the money goes, which is what stops a
 * finder from chasing support for a reward that is already on its way.
 */
export function renderSendFinderItemCollectedEmail(
    to: string,
    itemName: string,
    dropoffCode: string
): { subject: string; body: string } {
    const subject = 'Your Found Item Has Been Returned / Bidhaa Uliyopata Imerejeshwa - Return4me';

    const content = [
        emailKicker('Thank you'),
        emailHeading('Thank You! The Item You Found Has Been Returned'),
        emailParagraph(
            `The item you handed in, <strong>${escapeHtml(itemName)}</strong>, has been collected by its owner. Because you reported it honestly, someone has their property back.`
        ),
        emailDetails([
            { label: 'Item', value: itemName },
            { label: 'Item code', value: dropoffCode, mono: true },
            { label: 'Status', value: 'Successfully Reclaimed' },
        ]),
        emailCallout({
            tone: 'success',
            label: 'Your thank-you is on the way',
            text: 'Your finder reward has been dispatched to the M-Pesa number you reported with. If it has not arrived within 24 hours, reply to this email quoting the item code above.',
        }),
        emailNote('Honest finders are the whole point of Return4me. Thank you for doing the right thing with something that was not yours.'),
        emailDivider('Kiswahili'),
        emailHeading('Asante! Bidhaa uliyoipata imerejeshwa kwa mmiliki'),
        emailParagraph(
            `Bidhaa uliyowasilisha, <strong>${escapeHtml(itemName)}</strong>, imechukuliwa na mmiliki wake. Kwa sababu uliiripoti kwa uaminifu, mtu amepata mali yake tena.`
        ),
        emailDetails([
            { label: 'Bidhaa', value: itemName },
            { label: 'Nambari ya bidhaa', value: dropoffCode, mono: true },
            { label: 'Hali', value: 'Imerejeshwa kikamilifu' },
        ]),
        emailCallout({
            tone: 'success',
            label: 'Asante yako inakuja',
            text: 'Zawadi yako ya mwadhi imetumwa kwenye nambari ya M-Pesa uliyoripoti nayo. Kama haijafika ndani ya saa 24, jibu barua pepe hii ukitaja nambari ya bidhaa hapo juu.',
        }),
        emailNote('Watu waaminifu kama wewe ndio msingi wa Return4me. Asante kwa kufanya jambo sahihi.'),
    ].join('\n');

    const { html } = buildEmailMessage({
        subject,
        preheader: `${itemName} was collected by its owner. Your finder reward is on the way.`,
        headerLabel: 'Reward on the way',
        accent: EMAIL_THEME.success,
        content,
        footerNote: `Keep this email as your reward reference for item ${escapeHtml(dropoffCode)}.`,
    });

    return { subject, body: html };
}
/**
 * INTERNAL ledger notification for an admin-visible money event (N8, EventType
 * ADMIN_TRANSACTION_LOG, subtypes PAYMENT_CONFIRMED and
 * HANDOVER_CONFIRMED_PENDING_SETTLEMENT).
 *
 * Deliberately machine-like: one flat key/value table of exactly the fields the
 * durable record holds, in the shared shell but with no marketing copy, because
 * this is an operations record rather than a message to a customer. It carries
 * no secret — no pickup code, no credential.
 */
export function renderSendAdminTransactionLogEmail(
    event: 'PAYMENT_CONFIRMED' | 'HANDOVER_CONFIRMED' | 'HANDOVER_CONFIRMED_PENDING_SETTLEMENT',
    claimId: string,
    itemId: string,
    amount: number | string,
    agentName: string
): { subject: string; body: string } {
    const subject = `[ADMIN LOG] ${event} - Claim ${claimId}`;

    const content = [
        emailKicker(`Admin log - ${event}`),
        emailHeading('RETURN4ME TRANSACTION LOG'),
        emailParagraph('A settlement event was recorded on the platform. The fields below are the entry as it was written:'),
        emailDetails([
            // RENDER time, not a time read off the record: this builder is pure
            // and takes no clock, so a RETRY re-renders and shows a later moment
            // than the original email did. That is the same accepted cosmetic
            // drift the handover date carries — see `notificationRetry.ts` —
            // documented here rather than left implicit.
            { label: 'Timestamp', value: new Date().toISOString(), mono: true },
            { label: 'Event', value: event, mono: true },
            { label: 'Claim ID', value: claimId, mono: true },
            { label: 'Item ID', value: itemId, mono: true },
            { label: 'Amount (KES)', value: String(amount), mono: true },
            { label: 'Agent point', value: agentName, mono: true },
        ]),
        emailCallout({
            tone: 'info',
            label: 'What this means',
            text: 'A logged event is a record, not an approval. If this entry is unexpected, open the claim in the admin console before any payout, handover or reassignment is allowed to proceed.',
        }),
        emailNote('Automated internal notification from Return4me. Do not forward it outside operations.'),
    ].join('\n');

    const { html } = buildEmailMessage({
        subject,
        preheader: `${event} recorded for claim ${claimId} - KES ${amount}.`,
        headerLabel: 'Internal log',
        accent: EMAIL_THEME.info,
        content,
        footerNote: `Claim ${escapeHtml(claimId)} / item ${escapeHtml(itemId)}.`,
    });

    return { subject, body: html };
}

export const EmailService = {
  /**
   * Send a general email.
   *
   * RETAINED UNCHANGED as `Promise<boolean>` for backward compatibility: this is
   * the public contract every existing caller and test depends on. N9 adds
   * `sendWithId()` underneath it rather than widening this return type, because
   * changing a boolean to an object would silently break every boolean consumer.
   */
  async send(to: string, subject: string, html: string, text?: string): Promise<boolean> {
    const result = await this.sendWithId(to, subject, html, text);
    return result.accepted;
  },

  /**
   * N9 — send and return the provider's message id.
   *
   * The Resend id was ALWAYS available here (`response.data?.id`) but was only
   * logged and discarded, which left `notification_events.provider_message_id`
   * permanently NULL for email. That matters because it is the only evidence
   * that could later resolve an AMBIGUOUS outcome — a crash between dispatch and
   * the durable `sent` update — via the Resend message-lookup API. Without the id
   * an ambiguous send is permanently unknowable.
   *
   * Returns the SAME accept/refuse decision as `send()`; there is exactly one
   * underlying Resend call, so the two cannot drift apart.
   */
  async sendWithId(
    to: string,
    subject: string,
    html: string,
    text?: string
  ): Promise<{ accepted: boolean; providerMessageId: string | null; providerError: unknown }> {
    if (!to || to.trim() === '') {
      return { accepted: false, providerMessageId: null, providerError: null };
    }

    // The From/Reply-To decision is centralized in config/emailConfig.ts, so the
    // sender and the production boot guard cannot disagree about which address
    // the platform sends as, or whether a Reply-To is advertised at all.
    // Precedence: EMAIL_FROM -> RESEND_FROM_EMAIL (legacy) -> the verified
    // return4me.co.ke default.
    const fromEmail = resolveEmailFrom();
    const replyTo = resolveEmailReplyTo();

    // Every message carries a text/plain alternative, derived from the SAME
    // html unless the caller supplied one, so the two parts cannot disagree. It
    // is built BEFORE the client check so the console outbox shows exactly what
    // a text-only client would render.
    const plainText = typeof text === 'string' && text.trim() !== '' ? text : htmlToPlainText(html);

    const client = getResendClient();

    if (!client) {
      // No Resend client (API key missing, empty or a placeholder). In
      // development/sandbox this prints to a console outbox and returns true so
      // dev flows work without a real provider. In production there is NO
      // simulated delivery: pretending an email was sent when it was not would
      // create false operational confidence (e.g. a "payment confirmed" or
      // "handover" email the customer never received), so production FAILS
      // CLOSED. `assertEmailTransportConfiguration()` in server.ts is what keeps
      // production from reaching this branch at all.
      if (process.env.NODE_ENV === 'production') {
        console.error('[EMAIL SERVICE] RESEND_API_KEY is not configured in production — refusing to claim the email was sent. No delivery happened.');
        return { accepted: false, providerMessageId: null, providerError: null };
      }
      console.log(`\n=================== [SANDBOX EMAIL OUTBOX] ===================`);
      console.log(`To: ${to}`);
      console.log(`From: ${fromEmail}`);
      console.log(`Reply-To: ${replyTo ?? '(none)'}`);
      console.log(`Subject: ${subject}`);
      console.log(`--- Body (text/plain part, as a text-only client renders it) ---`);
      console.log(plainText);
      console.log(`--- Body (text/html part, ${html.length} bytes) ---`);
      console.log(html);
      console.log(`==============================================================\n`);
      return { accepted: true, providerMessageId: null, providerError: null };
    }

    try {
      const sendPromise = client.emails.send({
        from: fromEmail,
        to,
        subject,
        html,
        // Multipart, not HTML-only. This is the deliverability change: an
        // HTML-only transactional message and a message whose only link is
        // inside an `href` are both a well-known penalty.
        text: plainText,
        // Omitted entirely when suppressed, rather than sent as an empty
        // string, which some providers reject and others echo as a broken
        // reply address.
        ...(replyTo ? { replyTo } : {}),
      });

      const response = await withProviderTimeout(sendPromise, 'Resend send');

      if (response.error) {
        console.error('[EMAIL SERVICE] Resend API error:', response.error);
        // The raw provider error is returned for CLASSIFICATION ONLY. It is
        // never persisted and never logged verbatim by the caller.
        return { accepted: false, providerMessageId: null, providerError: response.error };
      }

      console.log(`[EMAIL SERVICE] Email successfully sent to ${to} (ID: ${response.data?.id})`);
      return {
        accepted: true,
        providerMessageId: response.data?.id ?? null,
        providerError: null,
      };
    } catch (error) {
      console.error('[EMAIL SERVICE] Failed to send email via Resend:', error);
      // A thrown error is AMBIGUOUS: the request may or may not have been
      // accepted before the connection broke. The classifier decides what that
      // means; this layer only reports that it is unknown.
      return { accepted: false, providerMessageId: null, providerError: error };
    }
  },

  /**
   * N8 COMPATIBILITY WRAPPER - transport only. Kept so any pre-existing
   * caller keeps working unchanged. The migrated business callers use
   * NotificationService instead and do not come through here. The
   * subject/HTML live in exactly one place: the builder above.
   */
  async sendPaymentReceivedEmail(
    to: string,
    ownerPhone: string,
    itemName: string,
    agentBusinessName: string,
    agentPhone: string,
    itemReference: string,
    pickupCode: string
  ): Promise<boolean> {
    const rendered = renderSendPaymentReceivedEmail(to, ownerPhone, itemName, agentBusinessName, agentPhone, itemReference, pickupCode);
    return this.send(to, rendered.subject, rendered.body);
  },

  /**
   * N8 COMPATIBILITY WRAPPER - transport only. Kept so any pre-existing
   * caller keeps working unchanged. The migrated business callers use
   * NotificationService instead and do not come through here. The
   * subject/HTML live in exactly one place: the builder above.
   */
  async sendItemHandedOverEmail(
    to: string,
    phone: string,
    itemName: string,
    dropoffCode: string,
    dateStr: string
  ): Promise<boolean> {
    const rendered = renderSendItemHandedOverEmail(to, phone, itemName, dropoffCode, dateStr);
    return this.send(to, rendered.subject, rendered.body);
  },

  /**
   * N8 COMPATIBILITY WRAPPER - transport only. Kept so any pre-existing
   * caller keeps working unchanged. The migrated business callers use
   * NotificationService instead and do not come through here. The
   * subject/HTML live in exactly one place: the builder above.
   */
  async sendAdminNewReassignmentRequestEmail(
    dropoffCode: string,
    locationDescription: string,
    finderPhone: string
  ): Promise<boolean> {
    const adminEmail = getAdminNotificationEmail();
    if (!adminEmail || adminEmail.trim() === '') {
      console.log(`[EMAIL SERVICE] Admin notification email not set. Skipping admin alert email for item ${dropoffCode}.`);
      return false;
    }

    // N8: the admin address is now resolved by the CALLER (see
    // services/adminNotification.ts). This guard is retained only so the
    // legacy wrapper's own return contract is unchanged.
    const rendered = renderSendAdminNewReassignmentRequestEmail(dropoffCode, locationDescription, finderPhone);
    return this.send(adminEmail, rendered.subject, rendered.body);
  },

  /**
   * N8 COMPATIBILITY WRAPPER - transport only. Kept so any pre-existing
   * caller keeps working unchanged. The migrated business callers use
   * NotificationService instead and do not come through here. The
   * subject/HTML live in exactly one place: the builder above.
   */
  async sendAgentPaymentConfirmedEmail(
    to: string,
    agentBusinessName: string,
    itemName: string,
    dropoffCode: string,
    claimId: string
  ): Promise<boolean> {
    const rendered = renderSendAgentPaymentConfirmedEmail(to, agentBusinessName, itemName, dropoffCode, claimId);
    return this.send(to, rendered.subject, rendered.body);
  },

  /**
   * N8 COMPATIBILITY WRAPPER - transport only. Kept so any pre-existing
   * caller keeps working unchanged. The migrated business callers use
   * NotificationService instead and do not come through here. The
   * subject/HTML live in exactly one place: the builder above.
   */
  async sendFinderItemCollectedEmail(
    to: string,
    itemName: string,
    dropoffCode: string
  ): Promise<boolean> {
    const rendered = renderSendFinderItemCollectedEmail(to, itemName, dropoffCode);
    return this.send(to, rendered.subject, rendered.body);
  },

  /**
   * N8 COMPATIBILITY WRAPPER - transport only. Kept so any pre-existing
   * caller keeps working unchanged. The migrated business callers use
   * NotificationService instead and do not come through here. The
   * subject/HTML live in exactly one place: the builder above.
   */
  async sendAdminTransactionLogEmail(
    event: 'PAYMENT_CONFIRMED' | 'HANDOVER_CONFIRMED' | 'HANDOVER_CONFIRMED_PENDING_SETTLEMENT',
    claimId: string,
    itemId: string,
    amount: number | string,
    agentName: string
  ): Promise<boolean> {
    const adminEmail = getAdminNotificationEmail();
    if (!adminEmail || adminEmail.trim() === '') {
      console.log(`[EMAIL SERVICE] Admin notification email not set. Skipping transaction log email for event ${event}.`);
      return false;
    }

    // N8: the admin address is now resolved by the CALLER (see
    // services/adminNotification.ts). This guard is retained only so the
    // legacy wrapper's own return contract is unchanged.
    const rendered = renderSendAdminTransactionLogEmail(event, claimId, itemId, amount, agentName);
    return this.send(adminEmail, rendered.subject, rendered.body);
  },
};