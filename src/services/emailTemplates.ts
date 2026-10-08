// SHARED TRANSACTIONAL EMAIL DESIGN SYSTEM.
//
// Every email the platform sends is built from these primitives, so a change to
// the brand (a colour, the footer, the legal line) is a change in ONE file
// rather than seven hand-copied template bodies.
//
// WHAT WAS WRONG BEFORE. The eight templates were inline `<div style="...">`
// chains with three different palettes (`#0f172a` navy in the lifecycle emails,
// `#003820` brand green in the activation emails, `#991b1b` red in the admin
// alert) and no shared structure at all. Three concrete consequences, all of
// which this module fixes:
//
//   1. NO PLAIN-TEXT ALTERNATIVE. Every message was HTML-only. Multipart
//      messages with a `text/plain` part are what filters and every text-mode
//      client expect; HTML-only mail is a well-known deliverability penalty, and
//      an activation link inside HTML-only mail cannot be clicked in the clients
//      that show the raw source. `htmlToPlainText()` below derives that part
//      from the same rendered HTML, so the two can never disagree.
//   2. NO DOCUMENT SHELL. The old bodies were body FRAGMENTS (`<div>` with no
//      doctype, `<head>` or `<body>`). Clients that require a document still
//      render a fragment, but they also apply their own default font size,
//      background and text colour per element — which is how a carefully styled
//      card arrives as unstyled black-on-white text. `renderEmailDocument()`
//      emits a full document with explicit colours on every container.
//   3. NO RESPONSIVE CONTAINER. A fixed 600px `<div>` overflows or shrinks
//      unpredictably on the low-cost Android devices this product targets, and
//      Outlook's desktop renderer ignores `max-width` on a div entirely. The
//      layout is table-based with `width="600"` for Outlook plus
//      `max-width:600px` for everyone else.
//
// DELIBERATELY NO IMAGES. The wordmark, the dividers, the status chips and the
// receipt details are all text and borders. That means no image host, no broken
// image placeholders, no blocked-by-default remote content, and no tracking
// pixel — an email about a lost wallet should not carry a beacon.
//
// DARK MODE is handled by DECLARING light (`color-scheme: light`) rather than by
// hand-writing a dark palette. Every container sets an explicit background and
// text colour, so a client that force-inverts only has two colours to flip and
// cannot end up with, for example, the pickup-code block silently inverting and
// the code becoming unreadable. That is the failure this product can least
// afford: the code is the physical-handover credential.


/**
 * Brand tokens, mirrored from the application theme (`src/index.css` @theme):
 * `--r4m-green`, `--r4m-orange`, `--color-brand-*` and the locked contrast
 * steps (`--color-accent-strong`). Kept as literals rather than imported from
 * CSS because an email cannot read CSS custom properties or the tailwind theme
 * — the values are duplicated here on purpose, and this comment is the link.
 */
export const EMAIL_THEME = {
  /** --r4m-green / --color-primary-green. 13.5:1 on white. The brand ink. */
  green: '#003820',
  /** --color-primary-hover. Lower band of the header. */
  greenDeep: '#002414',
  /** --r4m-green-light. */
  greenLight: '#196323',
  /** --r4m-orange. DECORATIVE only (rules, chips) — never text or a button. */
  orange: '#EC7E0D',
  /** --color-accent-strong: a white label on this is 4.80:1 (AA). */
  accentStrong: '#B35A00',
  /** --r4m-cream — the outer page background. */
  cream: '#FDF8EE',
  /** --color-brand-light-gray — inset panels. */
  surface: '#F4EFE6',
  /** --color-brand-border — 1px hairlines. */
  border: '#E8E1D3',
  /** --color-brand-dark-text — headings on white (13.5:1). */
  ink: '#003820',
  /** --color-brand-muted-text — body copy on white (6.4:1, AA). */
  muted: '#605B50',
  /** --color-status-success* — verified / completed / released. */
  success: '#15803D',
  successSurface: '#ECFDF5',
  successBorder: '#BBF7D0',
  /** --color-status-warning* — pending / action required. */
  warning: '#B45309',
  warningSurface: '#FEF3C7',
  warningBorder: '#FDE68A',
  /** --color-status-danger* — failed / blocked / destructive. */
  danger: '#B91C1C',
  dangerSurface: '#FEF2F2',
  dangerBorder: '#FECACA',
  /** --color-status-info* — neutral informational notice. */
  info: '#0369A1',
  infoSurface: '#F0F9FF',
  infoBorder: '#E0F2FE',
  /** --font-sans, with a real fallback chain for mail clients. */
  fontSans:
    "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  /** --font-mono — for codes, references and the admin log. */
  fontMono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace",
  /** The published support mailbox (also see src/config/emailConfig.ts). */
  supportEmail: 'support@return4me.co.ke',
  /** Public site, used for the footer link. */
  siteUrl: 'https://return4me.co.ke',
  /** The platform's one-line identity, used in every email footer. */
  tagline: 'Lost-and-found help for Kenya',
} as const;

export type EmailTone = 'brand' | 'success' | 'warning' | 'danger' | 'info';

type TonePalette = { text: string; surface: string; border: string };

/** Resolves a semantic tone to its three colours. */
export function tonePalette(tone: EmailTone): TonePalette {
  const t = EMAIL_THEME;
  switch (tone) {
    case 'success':
      return { text: t.success, surface: t.successSurface, border: t.successBorder };
    case 'warning':
      return { text: t.warning, surface: t.warningSurface, border: t.warningBorder };
    case 'danger':
      return { text: t.danger, surface: t.dangerSurface, border: t.dangerBorder };
    case 'info':
      return { text: t.info, surface: t.infoSurface, border: t.infoBorder };
    default:
      return { text: t.green, surface: t.cream, border: t.border };
  }
}

/**
 * Escapes a value for HTML text or a double-quoted attribute.
 *
 * Every interpolated value in every template goes through this. The values
 * include a customer's own full name, an agent's business name and a merchant
 * descriptor, so this is the boundary that stops a crafted name from injecting
 * markup into a message rendered by a third party.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    // Control characters can break a header or a table cell, and none are ever
    // meaningful in a name, a reference or a phone number.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** Escapes a value for an `href`, and neutralises a `javascript:` URL. */
export function escapeUrl(value: string): string {
  const text = String(value ?? '').trim();
  if (/^\s*javascript:/i.test(text)) return '#';
  return escapeHtml(text);
}

// ===========================================================================
// DOCUMENT SHELL
// ===========================================================================

export type EmailDocumentOptions = {
  /**
   * The inbox preview line. Not shown in the body — it becomes the grey text a
   * mail client shows next to the subject, so it should carry the one fact that
   * makes the message worth opening (a code, an amount, a deadline).
   */
  preheader: string;
  /** The `<title>`; some clients surface it, most do not. */
  title: string;
  /** Small right-aligned label in the header, e.g. "Verification". */
  headerLabel?: string;
  /** The card body as already-escaped HTML. */
  content: string;
  /** Colour of the 5px rule under the header. Defaults to brand orange. */
  accent?: string;
  /** One extra muted paragraph above the standard footer. */
  footerNote?: string;
};

/**
 * Wraps card content in the full branded document.
 *
 * The header is the wordmark plus a category label, the card carries the
 * message, and the footer is fixed: tagline, support address, security reminder
 * and copyright. Templates supply their content and never re-state the chrome,
 * so the footer cannot drift between messages.
 */
export function renderEmailDocument(options: EmailDocumentOptions): string {
  const t = EMAIL_THEME;
  const accent = options.accent ?? t.orange;
  const footerNote = options.footerNote
    ? `<p style="margin:0 0 4px 0;font-size:13px;line-height:1.6;color:${t.muted};">${options.footerNote}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en" style="color-scheme:light;">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(options.title)}</title>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${t.cream};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;color:${t.cream};">${escapeHtml(options.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${t.cream};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#FFFFFF;border:1px solid ${t.border};border-radius:16px;overflow:hidden;">
<tr><td style="background-color:${t.green};padding:20px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
<tr>
<td style="font-family:${t.fontSans};font-size:19px;font-weight:700;color:#FFFFFF;letter-spacing:-0.01em;">Return4me<span style="color:${t.orange};">.</span></td>
<td align="right" style="font-family:${t.fontSans};font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#C6DFCE;white-space:nowrap;">${escapeHtml(options.headerLabel ?? 'Kenya Lost &amp; Found')}</td>
</tr>
</table>
</td></tr>
<tr><td style="height:5px;background-color:${accent};font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:30px 28px 4px 28px;font-family:${t.fontSans};font-size:15px;line-height:1.65;color:${t.ink};">${options.content}</td></tr>
<tr><td style="padding:0 28px 28px 28px;font-family:${t.fontSans};">
<hr style="border:none;border-top:1px solid ${t.border};margin:22px 0 16px 0;" />
${footerNote}
<p style="margin:0 0 6px 0;font-size:13px;line-height:1.6;color:${t.muted};">${escapeHtml(t.tagline)}</p>
<p style="margin:0;font-size:13px;line-height:1.6;color:${t.muted};">Questions? <a href="mailto:${escapeHtml(t.supportEmail)}" style="color:${t.green};text-decoration:underline;">${escapeHtml(t.supportEmail)}</a> &middot; <a href="${escapeUrl(t.siteUrl)}" style="color:${t.green};text-decoration:underline;">return4me.co.ke</a></p>
<p style="margin:10px 0 0 0;font-size:12px;line-height:1.6;color:#8A857A;">&copy; ${new Date().getFullYear()} Return4me. Nairobi, Kenya.</p>
<p style="margin:6px 0 0 0;font-size:12px;line-height:1.6;color:#8A857A;">Automated message: never reply with your ID number, M-Pesa PIN or password.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ===========================================================================
// CONTENT BLOCKS
//
// Each block returns one self-contained HTML fragment. Anything a block takes
// as a plain `string` is ESCAPED by the block; anything documented as "HTML" is
// inserted verbatim and is the caller's responsibility (the templates only ever
// pass their own markup with already-escaped values in it).
// ===========================================================================

/** The category line above the heading. A paragraph, not a heading, so a screen reader announces one heading only. */
export function emailKicker(text: string): string {
  const t = EMAIL_THEME;
  return `<p style="margin:0 0 6px 0;font-family:${t.fontSans};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${t.muted};">${escapeHtml(text)}</p>`;
}

/** The card's H1. Plain text: any emphasis belongs in a paragraph. */
export function emailHeading(text: string): string {
  const t = EMAIL_THEME;
  return `<h1 style="margin:0 0 14px 0;font-family:${t.fontSans};font-size:21px;line-height:1.3;font-weight:700;color:${t.ink};letter-spacing:-0.01em;">${escapeHtml(text)}</h1>`;
}

/** A body paragraph. `html` must already be escaped. */
export function emailParagraph(html: string): string {
  const t = EMAIL_THEME;
  return `<p style="margin:0 0 14px 0;font-family:${t.fontSans};font-size:15px;line-height:1.65;color:${t.ink};">${html}</p>`;
}

/** Muted small print: disclaimers, expiry hints, "do not share this". */
export function emailNote(html: string): string {
  const t = EMAIL_THEME;
  return `<p style="margin:0 0 14px 0;font-family:${t.fontSans};font-size:13px;line-height:1.6;color:${t.muted};">${html}</p>`;
}

/**
 * A labelled, thumb-sized code: the pickup code, the claim-verification code,
 * the transfer reference. Centred, monospaced and widely letter-spaced so it can
 * be read off a phone screen and compared digit by digit at a handover.
 */
export function emailCodeBlock(options: {
  label: string;
  code: string;
  hint?: string;
  tone?: EmailTone;
}): string {
  const t = EMAIL_THEME;
  const p = tonePalette(options.tone ?? 'brand');
  const hint = options.hint
    ? `<p style="margin:8px 0 0 0;font-family:${t.fontSans};font-size:13px;line-height:1.55;color:${t.muted};">${escapeHtml(options.hint)}</p>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 18px 0;">
<tr><td align="center" style="background-color:${p.surface};border:1px dashed ${p.border};border-radius:12px;padding:18px 16px;">
<p style="margin:0 0 6px 0;font-family:${t.fontSans};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${p.text};">${escapeHtml(options.label)}</p>
<p style="margin:0;font-family:${t.fontMono};font-size:30px;line-height:1.2;font-weight:700;letter-spacing:0.18em;color:${p.text};word-break:break-all;">${escapeHtml(options.code)}</p>
${hint}
</td></tr>
</table>`;
}

/**
 * The primary call to action.
 *
 * `fallback: true` prints the raw URL underneath as well. An activation link is
 * the whole point of that message and there is no second channel to resend it
 * on, so the address is always printed, not only when the button is expected to
 * fail.
 */
export function emailButton(options: {
  href: string;
  label: string;
  tone?: 'brand' | 'accent' | 'danger';
  fallback?: boolean;
}): string {
  const t = EMAIL_THEME;
  const bg = options.tone === 'accent'
    ? t.accentStrong
    : options.tone === 'danger'
      ? t.danger
      : t.green;
  const href = escapeUrl(options.href);
  const fallback = options.fallback
    ? emailNote(`If the button does not work, copy this address into your browser:<br /><span style="font-family:${t.fontMono};font-size:12px;color:${t.green};word-break:break-all;">${escapeHtml(options.href)}</span>`)
    : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
<tr><td align="center" bgcolor="${bg}" style="background-color:${bg};border-radius:10px;">
<a href="${href}" style="display:inline-block;padding:14px 26px;font-family:${t.fontSans};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;">${escapeHtml(options.label)}</a>
</td></tr>
</table>
${fallback}`;
}

/** A bordered receipt-style key/value table. Values are plain text. */
export function emailDetails(rows: Array<{ label: string; value: string; mono?: boolean }>): string {
  const t = EMAIL_THEME;
  const body = rows
    .map((row, index) => {
      const edge = index === rows.length - 1 ? '' : `border-bottom:1px solid ${t.border};`;
      const font = row.mono
        ? `font-family:${t.fontMono};font-size:13px;`
        : `font-family:${t.fontSans};font-size:14px;`;
      return `<tr>
<td style="padding:11px 14px;background-color:${t.surface};${edge}font-family:${t.fontSans};font-size:13px;font-weight:600;color:${t.muted};width:42%;vertical-align:top;">${escapeHtml(row.label)}</td>
<td style="padding:11px 14px;${edge}${font}font-weight:600;color:${t.ink};word-break:break-word;">${escapeHtml(row.value)}</td>
</tr>`;
    })
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid ${t.border};border-radius:12px;overflow:hidden;margin:0 0 18px 0;">
${body}
</table>`;
}

/** A bulleted list of already-escaped items. */
export function emailList(items: string[]): string {
  const t = EMAIL_THEME;
  const lis = items
    .map((item) => `<li style="margin:0 0 6px 0;font-family:${t.fontSans};font-size:15px;line-height:1.6;color:${t.ink};">${item}</li>`)
    .join('\n');
  return `<ul style="margin:0 0 16px 0;padding-left:22px;">
${lis}
</ul>`;
}

/** A left-rule callout for a warning, a policy or a "what happens next". */
export function emailCallout(options: { text: string; tone?: EmailTone; label?: string }): string {
  const t = EMAIL_THEME;
  const p = tonePalette(options.tone ?? 'brand');
  const label = options.label
    ? `<p style="margin:0 0 4px 0;font-family:${t.fontSans};font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${p.text};">${escapeHtml(options.label)}</p>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 18px 0;">
<tr><td style="border-left:4px solid ${p.text};background-color:${p.surface};border-radius:0 10px 10px 0;padding:12px 14px;">
${label}<p style="margin:0;font-family:${t.fontSans};font-size:14px;line-height:1.6;color:${t.ink};">${options.text}</p>
</td></tr>
</table>`;
}

/**
 * REMOVED IN BATCH B — the English/Swahili splitter (`emailDivider`).
 *
 * It existed solely to introduce the second, Kiswahili-only half of a message.
 * The product is English-only, every one of those halves has been deleted, and
 * the function's DEFAULT argument was the word "Kiswahili" — so keeping it would
 * have left a helper whose only remaining behaviour was to print a language
 * header for text that no longer exists. No caller remains.
 */

// ===========================================================================
// PLAIN-TEXT ALTERNATIVE
// ===========================================================================

/**
 * Derives the `text/plain` part from the rendered HTML.
 *
 * This is a deliberately small converter rather than a dependency: the input is
 * our own known-simple markup (tables, paragraphs, lists, links) and pulling in
 * an HTML parser or a sanitiser to produce it would be a bigger surface than the
 * problem. It handles the four things that actually matter:
 *
 *   - LINKS BECOME VISIBLE. A URL that exists only in an `href` is unreachable in
 *     the plain-text part, and the plain-text part is exactly what a text-mode
 *     client shows. `label (url)` unless the label already is the URL.
 *   - BLOCK BOUNDARIES BECOME NEWLINES, so the receipt table does not collapse to
 *     one run-on line ("Collection point Return4me Hub Nairobi").
 *   - TABLE CELLS BECOME `Label: Value`.
 *   - THE HIDDEN PREHEADER IS DROPPED, so the preview line is not repeated as the
 *     first line of the body.
 *
 * Entities are decoded after tags are removed, which is also why the anchor
 * branch above compares an entity-decoded href.
 */
export function htmlToPlainText(html: string): string {
  const flattened = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, '')
    // The inbox-preview div is display:none, which carries no meaning in text.
    .replace(/<div style="display:none[\s\S]*?<\/div>/gi, '')
    // Links first, while the href is still an attribute.
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs: string, label: string) => {
      const hrefMatch = /href="([^"]*)"/i.exec(attrs);
      const text = String(label).replace(/<[^>]+>/g, '').trim();
      if (!hrefMatch) return text;
      const href = hrefMatch[1];
      const decoded = href.replace(/&amp;/g, '&');
      if (!text) return decoded;
      return text.includes(decoded) || text.includes(href) ? text : `${text} (${decoded})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n--------------------------------\n')
    .replace(/<\/td>\s*<td\b[^>]*>/gi, ': ')
    .replace(/<\/th>\s*<th\b[^>]*>/gi, ': ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|h1|h2|h3|h4|li|table|ul|ol|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return flattened
    .replace(/&nbsp;/gi, ' ')
    .replace(/&middot;/gi, '-')
    .replace(/&copy;/gi, '(c)')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .split('\n')
    .map((line) => line.replace(/[ \t\u00A0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The one place a subject, its HTML body and its plain-text body are bound
 * together.
 *
 * Building all three here means a template CANNOT ship HTML without the text
 * part — the previous templates did exactly that, because each one assembled its
 * own body string and the transport then had nothing to derive from.
 */
export type EmailMessageOptions = {
  subject: string;
  /** Inbox preview line. */
  preheader: string;
  headerLabel?: string;
  accent?: string;
  /** Card body, already escaped. */
  content: string;
  footerNote?: string;
};

export type RenderedEmailMessage = {
  subject: string;
  html: string;
  text: string;
};

export function buildEmailMessage(options: EmailMessageOptions): RenderedEmailMessage {
  const html = renderEmailDocument({
    preheader: options.preheader,
    title: options.subject,
    headerLabel: options.headerLabel,
    accent: options.accent,
    content: options.content,
    footerNote: options.footerNote,
  });
  return { subject: options.subject, html, text: htmlToPlainText(html) };
}
