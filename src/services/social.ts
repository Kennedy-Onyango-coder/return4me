import dotenv from 'dotenv';
import crypto from 'crypto';
import { db } from '../db/database';
import { buildSafePublicClues } from './publicRecognition';

dotenv.config();

// Defends against copy-paste corruption in .env values — the same class of bug
// that previously broke Africa's Talking (smart/curly quotes silently embedded
// instead of being stripped). For Telegram specifically, a "smart" or "en" dash
// (– U+2013, — U+2014) substituted for a plain hyphen-minus (- U+002D) in
// TELEGRAM_CHANNEL_ID would look visually identical in most fonts/screenshots
// but is a completely different character, silently breaking the "-100..."
// channel ID prefix and causing Telegram's API to report "chat not found" even
// though the channel, bot permissions, and everything else are correctly set up.
function sanitizeTelegramEnvValue(raw: string | undefined): string {
  if (!raw) return '';
  let v = raw.trim();
  v = v.replace(/^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019]+$/g, '');
  // Normalize any smart/en/em dash to a plain ASCII hyphen-minus.
  v = v.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-');
  return v.trim();
}

/**
 * Sanitizes untrusted, Finder-controlled free text (item.description,
 * item.location_description) before it reaches ANY public social post.
 * A Finder filling out the found-item report is an anonymous member of the
 * public — this text must be treated the same as any other untrusted user
 * input, not as safe content just because it came through our own form.
 *
 * Strips:
 * - full URLs (http/https/www.) — prevents a Finder embedding a phishing
 *   link disguised as part of a legitimate Return4me post
 * - phone numbers (Kenyan mobile formats) and email addresses — prevents
 *   PII leakage and off-platform contact-fishing through a "found item"
 *   post
 * - excessive whitespace a Finder could use to visually break the post's
 *   formatting
 *
 * When htmlEscape is true (Telegram, which posts with parse_mode: 'HTML'),
 * also escapes &, <, > so the text can never be interpreted as markup —
 * without this, a description like `<a href="evil.com">real return4me
 * link</a>` would render as an actual clickable link inside our own post.
 */
export function sanitizeSocialText(raw: string | null | undefined, opts: { htmlEscape?: boolean } = {}): string {
  let text = (raw || '').toString();

  text = text.replace(/https?:\/\/\S+/gi, '[link removed]');
  text = text.replace(/\bwww\.\S+/gi, '[link removed]');
  text = text.replace(/(?:\+254|254|0)[71]\d{8}\b/g, '[phone removed]');
  text = text.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email removed]');
  text = text.replace(/\s{3,}/g, '  ').trim();

  if (opts.htmlEscape) {
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return text || 'Not provided.';
}

interface TwitterOAuthCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

function oauthPercentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Builds an OAuth 1.0a "Authorization" header for a Twitter/X API request.
 * No extra dependency (e.g. `twitter-api-v2`) is used — this is a minimal,
 * self-contained HMAC-SHA1 signer since Twitter/X's media upload and tweet
 * creation endpoints both still require OAuth 1.0a user-context auth for a
 * bot posting as a specific account.
 */
function buildOAuth1Header(
  method: 'POST' | 'GET',
  url: string,
  extraParams: Record<string, string>,
  creds: TwitterOAuthCreds
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };

  const allParams: Record<string, string> = { ...oauthParams, ...extraParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((key) => `${oauthPercentEncode(key)}=${oauthPercentEncode(allParams[key])}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    oauthPercentEncode(url),
    oauthPercentEncode(paramString),
  ].join('&');

  const signingKey = `${oauthPercentEncode(creds.apiSecret)}&${oauthPercentEncode(creds.accessTokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams = { ...oauthParams, oauth_signature: signature };
  const headerString = Object.keys(headerParams)
    .sort()
    .map((key) => `${oauthPercentEncode(key)}="${oauthPercentEncode(headerParams[key])}"`)
    .join(', ');

  return `OAuth ${headerString}`;
}

export interface SocialItem {
  id: string;
  category_id: string | null;
  ocr_extracted_number?: string | null;
  ocr_extracted_name?: string | null;
  location_description: string;
  description?: string | null;
  is_sensitive_document: boolean;
  locked_total_fee?: string | number | null;
  photo_url?: string | null;
  verified_name?: string | null;
  verified_document_number?: string | null;
  verified_found_area?: string | null;
  verification_status?: string;
}

export interface SocialAgent {
  id: string;
  business_name: string;
  location_address: string;
  contact_phone: string;
}

export interface SocialCategory {
  id: string;
  name_en: string;
  name_sw: string;
  total_fee: string | number;
  is_sensitive_document: boolean;
  public_clue_style?: string;
}

/**
 * Utility functions for protecting PII (Personally Identifiable Information)
 * in compliance with Kenya Data Protection Act 2019 (Section 40)
 */
export function maskName(name: string): string {
  if (!name) return '***';
  const parts = name.trim().split(/\s+/);
  return parts.map((part, index) => {
    if (index === 0) {
      if (part.length <= 2) return part;
      return part.slice(0, 2) + '***' + part.slice(-1);
    }
    if (part.length === 0) return '';
    return part[0] + '***';
  }).join(' ');
}

export function maskDocumentNumber(num: string): string {
  if (!num) return '****';
  const clean = num.trim();
  if (clean.length <= 4) return '***' + clean.slice(-1);
  return clean.slice(0, 2) + '****' + clean.slice(-2);
}

/**
 * HTML-escapes a value for Telegram's HTML parse mode ONLY — no URL/phone/
 * email scrubbing (unlike sanitizeSocialText). Use this for admin-
 * controlled values (category names, Agent business name/address) that
 * aren't Finder-supplied free text but should still never be able to
 * break Telegram's HTML parsing or inject markup — e.g. if a category
 * name is ever edited to include a stray `<` character. For genuinely
 * untrusted Finder-controlled text (description, location), use
 * sanitizeSocialText(..., { htmlEscape: true }) instead, which also
 * strips embedded links/phone numbers/emails.
 */
export function escapeTelegramHtml(raw: string | null | undefined): string {
  return (raw || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const SocialService = {
  /**
   * Emergency-stop check enforced INSIDE the service itself, not just at
   * the calling route. Defense in depth: route.ts already checks this
   * before calling broadcastVerifiedItem/broadcastItemReunited, but that
   * means the guarantee lives only as long as every current and future
   * call site remembers to check first. Enforcing it here too means the
   * pause holds even if a future code path calls SocialService directly.
   * Fails safe: if the setting can't be read at all, treat that the same
   * as "paused" — never publish when uncertain.
   */
  async _isPublishingPaused(): Promise<boolean> {
    try {
      const value = await db.getSetting('social_publishing_paused');
      return value === 'true';
    } catch (err) {
      console.error('[SOCIAL SERVICE] Failed to read publishing-pause setting — failing safe (treating as paused):', err);
      return true;
    }
  },

  /**
   * Post a verified recovery update to Telegram Channel
   */
  async postToTelegram(item: SocialItem, agent?: SocialAgent, category?: SocialCategory): Promise<boolean> {
    const botToken = sanitizeTelegramEnvValue(process.env.TELEGRAM_BOT_TOKEN);
    const channelId = sanitizeTelegramEnvValue(process.env.TELEGRAM_CHANNEL_ID);

    const isSensitive = item.is_sensitive_document || (category ? category.is_sensitive_document : false);
    const categoryName = category ? `${category.name_en} / ${category.name_sw}` : 'Lost Item';
    const fee = item.locked_total_fee || (category ? category.total_fee : '200');

    let text = '';
    if (isSensitive) {
      // Recognition clues, not authentication: enough that a genuine
      // owner thinks "this could be mine", never enough to prove it.
      // Built exclusively through PublicRecognitionService from
      // Agent-VERIFIED fields — never straight from Finder-submitted
      // data. See buildSafePublicClues and the guard in
      // broadcastVerifiedItem above.
      const clues = buildSafePublicClues(item, category || { public_clue_style: 'generic' });
      const nameLine = clues.nameClue ? `<b>Name clue:</b> <code>${escapeTelegramHtml(clues.nameClue)}</code>\n` : '';
      const numberLine = clues.documentNumberClue ? `<b>ID clue:</b> <code>${escapeTelegramHtml(clues.documentNumberClue)}</code>\n` : '';

      text = `<b>FOUND: ${escapeTelegramHtml(categoryName).toUpperCase()}</b>\n\n` +
             nameLine +
             numberLine +
             `<b>Found around:</b> ${escapeTelegramHtml(clues.location)}\n\n` +
             `A verified item is safely held by a Return4me Agent.\n\n` +
             `Think this may be yours?\n\n` +
             `Verify ownership securely through Return4me. Use the private claim workflow for real identity matching — this post is never sufficient to claim the item on its own.\n\n` +
             `<b>Claim Link:</b> <a href="https://return4me.co.ke/?claim=${item.id}">https://return4me.co.ke/?claim=${item.id}</a>`;
    } else {
      const itemDesc = sanitizeSocialText(item.description, { htmlEscape: true }) || 'No additional details provided.';
      const safeLocation = sanitizeSocialText(item.location_description, { htmlEscape: true });

      text = `<b>NOTICE OF FOUND ITEM</b>\n\n` +
             `A lost item has been deposited and verified at an authorized Return4me agent hub.\n\n` +
             `<b>Category:</b> ${escapeTelegramHtml(categoryName)}\n` +
             `<b>Location Found:</b> ${safeLocation}\n` +
             `<b>Collection Point:</b> ${agent ? escapeTelegramHtml(agent.business_name) : 'Return4me Hub'}, ${agent ? escapeTelegramHtml(agent.location_address) : 'Kenya'}\n` +
             `<b>Description:</b> <i>${itemDesc}</i>\n\n` +
             `<b>Status:</b> Physically verified by authorized agent.\n\n` +
             `To claim this item, please visit the portal link below.\n\n` +
             `<b>Claim Link:</b> <a href="https://return4me.co.ke/?claim=${item.id}">https://return4me.co.ke/?claim=${item.id}</a>`;
    }

    // SAFETY: only ever attach a photo for confirmed non-sensitive items. Sensitive
    // documents (national ID, passport, logbook, etc.) must never have their photo
    // published, regardless of what is passed in — this check is deliberately
    // redundant with the caller's own check, since this is the last line of defense
    // before anything goes out publicly.
    const canShowPhoto = !isSensitive && !!item.photo_url;

    if (!botToken || botToken.trim() === '' || !channelId || channelId.trim() === '') {
      // P0: this used to unconditionally `return true` here — meaning a
      // production deploy with missing/misconfigured Telegram credentials
      // would report every post as successfully published, and
      // broadcastVerifiedItem below would write a 'published' row to
      // social_publications for a post that never actually went out. The
      // sandbox-outbox behavior (log the content, return success) is a
      // legitimate dev/preview convenience — same class of exception this
      // codebase already applies consistently elsewhere (storage,
      // payments, DB) — but must never silently happen in production.
      if (process.env.NODE_ENV === 'production') {
        console.error('[SOCIAL SERVICE] FATAL: TELEGRAM_BOT_TOKEN/TELEGRAM_CHANNEL_ID missing in production. Refusing to report a fake success.');
        return false;
      }
      console.log(`\n=================== [SANDBOX TELEGRAM OUTBOX] ===================`);
      console.log(`Channel ID: ${channelId || '[NOT CONFIGURED]'}`);
      console.log(`Photo attached: ${canShowPhoto ? 'YES - ' + item.photo_url : 'no'}`);
      console.log(`--- Post Content ---`);
      console.log(text.replace(/<[^>]*>/g, '')); // log stripped html for readability
      console.log(`=================================================================\n`);
      return true;
    }

    try {
      if (canShowPhoto) {
        // Telegram caption length limit is 1024 characters — truncate defensively
        // and point to the full text via the same claim link already embedded.
        const caption = text.length > 1024 ? text.slice(0, 1000) + '\u2026' : text;

        try {
          // Fetch the image bytes ourselves and upload as multipart binary rather
          // than passing the presigned storage URL directly — this avoids relying
          // on Telegram's own server successfully fetching a URL with a long AWS
          // Signature v4 query string, the same class of risk that broke this on
          // Facebook's side.
          const imageRes = await fetch(item.photo_url!);
          if (!imageRes.ok) {
            throw new Error(`Failed to fetch photo bytes from storage (HTTP ${imageRes.status})`);
          }
          const imageBuffer = await imageRes.arrayBuffer();
          const imageBlob = new Blob([imageBuffer], { type: imageRes.headers.get('content-type') || 'image/jpeg' });

          const form = new FormData();
          form.append('chat_id', channelId);
          form.append('photo', imageBlob, 'item-photo.jpg');
          form.append('caption', caption);
          form.append('parse_mode', 'HTML');

          const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
          const res = await fetch(url, { method: 'POST', body: form as any });

          if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            console.error('[SOCIAL SERVICE] Telegram sendPhoto API error, falling back to text-only post:', errorData);
            // Fall through to text-only send below rather than losing the post entirely.
          } else {
            console.log(`[SOCIAL SERVICE] Telegram photo broadcast success for item ${item.id}`);
            return true;
          }
        } catch (fetchErr) {
          console.error('[SOCIAL SERVICE] Failed to fetch/upload photo bytes for Telegram, falling back to text-only post:', fetchErr);
          // Fall through to text-only send below.
        }
      }

      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: channelId,
          text: text,
          parse_mode: 'HTML',
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error('[SOCIAL SERVICE] Telegram API error:', errorData);
        return false;
      }

      console.log(`[SOCIAL SERVICE] Telegram broadcast success for item ${item.id}`);
      return true;
    } catch (e) {
      console.error('[SOCIAL SERVICE] Failed to post to Telegram:', e);
      return false;
    }
  },

  /**
   * Post a verified recovery update to Facebook Page Feed
   */
  async postToFacebook(item: SocialItem, agent?: SocialAgent, category?: SocialCategory): Promise<boolean> {
    const pageId = process.env.FACEBOOK_PAGE_ID;
    const pageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

    const isSensitive = item.is_sensitive_document || (category ? category.is_sensitive_document : false);
    const categoryName = category ? `${category.name_en} / ${category.name_sw}` : 'Lost Item';
    const fee = item.locked_total_fee || (category ? category.total_fee : '200');

    let text = '';
    if (isSensitive) {
      const clues = buildSafePublicClues(item, category || { public_clue_style: 'generic' });
      const nameLine = clues.nameClue ? `Name clue: ${sanitizeSocialText(clues.nameClue)}\n` : '';
      const numberLine = clues.documentNumberClue ? `ID clue: ${sanitizeSocialText(clues.documentNumberClue)}\n` : '';

      text = `FOUND: ${categoryName.toUpperCase()}\n\n` +
             nameLine +
             numberLine +
             `Found around: ${sanitizeSocialText(clues.location)}\n\n` +
             `A verified item is safely held by a Return4me Agent.\n\n` +
             `Think this may be yours?\n\n` +
             `Verify ownership securely through Return4me. Use the private claim workflow for real identity matching — this post is never sufficient to claim the item on its own.\n\n` +
             `Claim Link: https://return4me.co.ke/?claim=${item.id}`;
    } else {
      const itemDesc = sanitizeSocialText(item.description) || 'No additional details provided.';
      const safeLocation = sanitizeSocialText(item.location_description);

      text = `NOTICE OF FOUND ITEM\n\n` +
             `A lost item has been deposited and verified at an authorized Return4me agent hub.\n\n` +
             `Category: ${categoryName}\n` +
             `Location Found: ${safeLocation}\n` +
             `Collection Point: ${agent ? agent.business_name : 'Return4me Hub'}, ${agent ? agent.location_address : 'Kenya'}\n` +
             `Description: ${itemDesc}\n\n` +
             `Status: Physically verified by authorized agent.\n\n` +
             `To claim this item, please visit the portal link below.\n\n` +
             `Claim Link: https://return4me.co.ke/?claim=${item.id}`;
    }

    // SAFETY: redundant, deliberate last-line-of-defense check — never attach a photo
    // for a sensitive document, regardless of what the caller passes in.
    const canShowPhoto = !isSensitive && !!item.photo_url;

    if (!pageId || pageId.trim() === '' || !pageAccessToken || pageAccessToken.trim() === '') {
      // P0: see the matching comment in postToTelegram above — same fix,
      // same reasoning.
      if (process.env.NODE_ENV === 'production') {
        console.error('[SOCIAL SERVICE] FATAL: FACEBOOK_PAGE_ID/FACEBOOK_PAGE_ACCESS_TOKEN missing in production. Refusing to report a fake success.');
        return false;
      }
      console.log(`\n=================== [SANDBOX FACEBOOK OUTBOX] ===================`);
      console.log(`Page ID: ${pageId || '[NOT CONFIGURED]'}`);
      console.log(`Photo attached: ${canShowPhoto ? 'YES - ' + item.photo_url : 'no'}`);
      console.log(`--- Post Content ---`);
      console.log(text);
      console.log(`=================================================================\n`);
      return true;
    }

    try {
      if (canShowPhoto) {
        // IMPORTANT: do NOT pass a presigned storage URL directly in the `url` field.
        // Facebook's server-side scraper frequently fails to fetch presigned URLs
        // that carry long AWS Signature v4 query strings (STORAGE bucket presigned
        // URLs), returning a cryptic "Please reduce the amount of data you're
        // asking for, then retry your request" (error code 1). Fetching the image
        // bytes ourselves and uploading as binary multipart data avoids Facebook's
        // scraper touching the signed URL entirely, and is the more reliable method
        // recommended for server-side integrations regardless.
        try {
          const imageRes = await fetch(item.photo_url!);
          if (!imageRes.ok) {
            throw new Error(`Failed to fetch photo bytes from storage (HTTP ${imageRes.status})`);
          }
          const imageBuffer = await imageRes.arrayBuffer();
          const imageBlob = new Blob([imageBuffer], { type: imageRes.headers.get('content-type') || 'image/jpeg' });

          const form = new FormData();
          form.append('source', imageBlob, 'item-photo.jpg');
          form.append('caption', text);
          form.append('access_token', pageAccessToken);

          const url = `https://graph.facebook.com/v18.0/${pageId}/photos`;
          const res = await fetch(url, { method: 'POST', body: form as any });

          if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            console.error('[SOCIAL SERVICE] Facebook photo post error, falling back to text-only post:', errorData);
            // Fall through to text-only feed post below rather than losing the post entirely.
          } else {
            console.log(`[SOCIAL SERVICE] Facebook photo post success for item ${item.id}`);
            return true;
          }
        } catch (fetchErr) {
          console.error('[SOCIAL SERVICE] Failed to fetch/upload photo bytes for Facebook, falling back to text-only post:', fetchErr);
          // Fall through to text-only feed post below.
        }
      }

      const url = `https://graph.facebook.com/v18.0/${pageId}/feed`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: text,
          access_token: pageAccessToken,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error('[SOCIAL SERVICE] Facebook Graph API error:', errorData);
        return false;
      }

      console.log(`[SOCIAL SERVICE] Facebook feed post success for item ${item.id}`);
      return true;
    } catch (e) {
      console.error('[SOCIAL SERVICE] Failed to post to Facebook:', e);
      return false;
    }
  },

  /**
   * Post a verified recovery update to Twitter/X
   */
  async postToTwitter(item: SocialItem, agent?: SocialAgent, category?: SocialCategory): Promise<boolean> {
    const apiKey = process.env.TWITTER_API_KEY?.trim();
    const apiSecret = process.env.TWITTER_API_SECRET?.trim();
    const accessToken = process.env.TWITTER_ACCESS_TOKEN?.trim();
    const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET?.trim();

    const isSensitive = item.is_sensitive_document || (category ? category.is_sensitive_document : false);
    const categoryName = category ? category.name_en : 'Lost Item';
    const claimLink = `https://return4me.co.ke/?claim=${item.id}`;

    // X/Twitter has a strict character limit, so this is a deliberately
    // compact variant of the same notice posted to Telegram/Facebook — full
    // detail lives on the claim page behind the link, not in the tweet itself.
    let text = '';
    if (isSensitive) {
      const clues = buildSafePublicClues(item, category || { public_clue_style: 'generic' });
      const nameLine = clues.nameClue ? ` (${sanitizeSocialText(clues.nameClue)})` : '';
      text = `FOUND: ${categoryName}${nameLine} near ${sanitizeSocialText(clues.location)}. Verified by a Return4me Agent. Think it's yours? Verify securely:\n${claimLink}`;
    } else {
      const safeLocation = sanitizeSocialText(item.location_description);
      text = `FOUND: ${categoryName} near ${safeLocation}, verified at a Return4me agent hub` +
             `${agent ? ' (' + agent.business_name + ')' : ''}. Claim it here:\n${claimLink}`;
    }
    if (text.length > 280) {
      text = text.slice(0, 277) + '\u2026';
    }

    // SAFETY: same deliberate redundant check as Telegram/Facebook — never
    // attach a photo for a sensitive document, no matter what is passed in.
    const canShowPhoto = !isSensitive && !!item.photo_url;

    if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
      // P0: see the matching comment in postToTelegram above — same fix,
      // same reasoning.
      if (process.env.NODE_ENV === 'production') {
        console.error('[SOCIAL SERVICE] FATAL: TWITTER_API_KEY/TWITTER_API_SECRET/TWITTER_ACCESS_TOKEN/TWITTER_ACCESS_TOKEN_SECRET missing in production. Refusing to report a fake success.');
        return false;
      }
      console.log(`\n=================== [SANDBOX TWITTER/X OUTBOX] ===================`);
      console.log(`Photo attached: ${canShowPhoto ? 'YES - ' + item.photo_url : 'no'}`);
      console.log(`--- Post Content ---`);
      console.log(text);
      console.log(`====================================================================\n`);
      return true;
    }

    const oauthCreds = { apiKey, apiSecret, accessToken, accessTokenSecret };

    try {
      let mediaId: string | undefined;

      if (canShowPhoto) {
        try {
          const imageRes = await fetch(item.photo_url!);
          if (!imageRes.ok) {
            throw new Error(`Failed to fetch photo bytes from storage (HTTP ${imageRes.status})`);
          }
          const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

          // Twitter/X media upload (v1.1) still requires OAuth 1.0a and expects
          // the image as base64-encoded form data for simple (non-chunked) uploads.
          const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json';
          const authHeader = buildOAuth1Header('POST', uploadUrl, {}, oauthCreds);
          const form = new URLSearchParams();
          form.append('media_data', imageBuffer.toString('base64'));

          const uploadRes = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              Authorization: authHeader,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: form.toString(),
          });

          if (!uploadRes.ok) {
            const errorData = await uploadRes.json().catch(() => ({}));
            console.error('[SOCIAL SERVICE] Twitter/X media upload error, falling back to text-only post:', errorData);
          } else {
            const uploadData = await uploadRes.json();
            mediaId = uploadData.media_id_string;
          }
        } catch (fetchErr) {
          console.error('[SOCIAL SERVICE] Failed to fetch/upload photo bytes for Twitter/X, falling back to text-only post:', fetchErr);
        }
      }

      // Create the tweet via API v2, still authenticated with OAuth 1.0a user
      // context (supported by v2's tweet-creation endpoint alongside OAuth2).
      const tweetUrl = 'https://api.twitter.com/2/tweets';
      const authHeader = buildOAuth1Header('POST', tweetUrl, {}, oauthCreds);
      const body: any = { text };
      if (mediaId) {
        body.media = { media_ids: [mediaId] };
      }

      const res = await fetch(tweetUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error('[SOCIAL SERVICE] Twitter/X API error:', errorData);
        return false;
      }

      console.log(`[SOCIAL SERVICE] Twitter/X post success for item ${item.id}`);
      return true;
    } catch (e) {
      console.error('[SOCIAL SERVICE] Failed to post to Twitter/X:', e);
      return false;
    }
  },

  /**
   * Broadcast verified recovery message to all configured social platforms
   */
  /**
   * Wraps a single platform post attempt with the durable idempotency
   * claim described on social_publications (schema.ts). Returns true only
   * if this call actually attempted the post AND it succeeded; returns
   * false both when the post genuinely failed and when it was skipped
   * because a slot was already claimed (already published, already
   * failed, or a concurrent attempt is in flight) — the caller doesn't
   * need to distinguish those cases for logging purposes, since either
   * way no further action is needed here.
   */
  async _runIdempotentPost(itemId: string, platform: string, publicationType: string, post: () => Promise<boolean>): Promise<boolean> {
    const claimed = await db.claimSocialPublicationSlot(itemId, platform, publicationType);
    if (!claimed) {
      console.log(`[SOCIAL SERVICE] Skipping ${platform} ${publicationType} for item ${itemId} — already claimed/published (idempotency guard).`);
      return false;
    }
    try {
      const success = await post();
      await db.recordSocialPublicationResult(itemId, platform, publicationType, { status: success ? 'published' : 'failed' });
      return success;
    } catch (err: any) {
      await db.recordSocialPublicationResult(itemId, platform, publicationType, { status: 'failed', lastError: String(err?.message || err) });
      return false;
    }
  },

  async broadcastVerifiedItem(item: SocialItem, agent?: SocialAgent, category?: SocialCategory): Promise<void> {
    if (await this._isPublishingPaused()) {
      console.log(`[SOCIAL SERVICE] Publishing is paused — skipping broadcast for item ID: ${item.id}.`);
      return;
    }

    // CRITICAL RULE: public sensitive-document clues must be built from
    // Agent-VERIFIED data, never straight from an unverified Finder
    // submission. confirm-dropoff (server.ts) already requires
    // verification_status !== 'pending' before an item can even reach
    // 'at_agent' (the status that triggers this broadcast) — this is a
    // second, defensive check at the point publication actually happens,
    // so a future code path that calls broadcastVerifiedItem some other
    // way can't accidentally publish an unverified sensitive item.
    if (item.is_sensitive_document && (!item.verification_status || item.verification_status === 'pending')) {
      console.error(`[SOCIAL SERVICE] Refusing to broadcast sensitive item ${item.id} — verification_status is '${item.verification_status || 'pending'}', not yet Agent-verified. This should be unreachable given confirm-dropoff's own guard; treating as a bug and failing safe.`);
      return;
    }

    console.log(`[SOCIAL SERVICE] Initiating social media broadcast for item ID: ${item.id}`);

    // Each platform post is individually claimed via the idempotency table
    // before being attempted — a retry, a duplicate call (e.g. two
    // near-simultaneous confirm-dropoff requests), or a server restart
    // mid-broadcast can never produce a duplicate post for the same
    // (item, platform, publication_type), because the DB-level unique
    // constraint on social_publications only lets the first claim win.
    const [tgResult, fbResult, twResult] = await Promise.all([
      this._runIdempotentPost(item.id, 'telegram', 'found_notice', () => this.postToTelegram(item, agent, category)),
      this._runIdempotentPost(item.id, 'facebook', 'found_notice', () => this.postToFacebook(item, agent, category)),
      this._runIdempotentPost(item.id, 'twitter', 'found_notice', () => this.postToTwitter(item, agent, category)),
    ]);

    console.log(`[SOCIAL SERVICE] Broadcast completed. Telegram: ${tgResult ? 'Success' : 'Failed/Skipped'}, Facebook: ${fbResult ? 'Success' : 'Failed/Skipped'}, Twitter/X: ${twResult ? 'Success' : 'Failed/Skipped'}`);
  },

  /**
   * Post a short follow-up notice once an item has been collected by its verified
   * owner, closing out the original listing publicly. Deliberately minimal — no
   * owner details (name, phone, photo) are ever included here, regardless of
   * whether the original item was sensitive or not, since this notice concerns
   * the person who claimed it, not the item itself.
   */
  async broadcastItemReunited(item: SocialItem, category?: SocialCategory): Promise<void> {
    if (await this._isPublishingPaused()) {
      console.log(`[SOCIAL SERVICE] Publishing is paused — skipping reunited-notice for item ID: ${item.id}.`);
      return;
    }
    const categoryName = category ? `${category.name_en} / ${category.name_sw}` : 'Item';
    const safeLocation = sanitizeSocialText(item.location_description);
    const text = `UPDATE: NOTICE CLOSED\n\n` +
      `The ${categoryName} previously reported found near ${safeLocation} has been verified and returned to its rightful owner.\n\n` +
      `This listing is now closed and no longer available for claim.`;

    const botToken = sanitizeTelegramEnvValue(process.env.TELEGRAM_BOT_TOKEN);
    const channelId = sanitizeTelegramEnvValue(process.env.TELEGRAM_CHANNEL_ID);
    const pageId = process.env.FACEBOOK_PAGE_ID;
    const pageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    const twApiKey = process.env.TWITTER_API_KEY?.trim();
    const twApiSecret = process.env.TWITTER_API_SECRET?.trim();
    const twAccessToken = process.env.TWITTER_ACCESS_TOKEN?.trim();
    const twAccessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET?.trim();

    const tgPromise = this._runIdempotentPost(item.id, 'telegram', 'reunited_notice', async () => {
      if (!botToken || !channelId) {
        // P0: see the matching comment in postToTelegram above.
        if (process.env.NODE_ENV === 'production') {
          console.error('[SOCIAL SERVICE] FATAL: TELEGRAM_BOT_TOKEN/TELEGRAM_CHANNEL_ID missing in production. Refusing to report a fake success (reunited notice).');
          return false;
        }
        console.log(`\n=================== [SANDBOX TELEGRAM OUTBOX - REUNITED] ===================`);
        console.log(text);
        console.log(`==============================================================================\n`);
        return true;
      }
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: channelId, text }),
        });
        if (!res.ok) {
          console.error('[SOCIAL SERVICE] Telegram reunited-notice error:', await res.json().catch(() => ({})));
          return false;
        }
        return true;
      } catch (e) {
        console.error('[SOCIAL SERVICE] Failed to post reunited notice to Telegram:', e);
        return false;
      }
    });

    const fbPromise = this._runIdempotentPost(item.id, 'facebook', 'reunited_notice', async () => {
      if (!pageId || !pageAccessToken) {
        // P0: see the matching comment in postToTelegram above.
        if (process.env.NODE_ENV === 'production') {
          console.error('[SOCIAL SERVICE] FATAL: FACEBOOK_PAGE_ID/FACEBOOK_PAGE_ACCESS_TOKEN missing in production. Refusing to report a fake success (reunited notice).');
          return false;
        }
        console.log(`\n=================== [SANDBOX FACEBOOK OUTBOX - REUNITED] ===================`);
        console.log(text);
        console.log(`==============================================================================\n`);
        return true;
      }
      try {
        const res = await fetch(`https://graph.facebook.com/v18.0/${pageId}/feed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, access_token: pageAccessToken }),
        });
        if (!res.ok) {
          console.error('[SOCIAL SERVICE] Facebook reunited-notice error:', await res.json().catch(() => ({})));
          return false;
        }
        return true;
      } catch (e) {
        console.error('[SOCIAL SERVICE] Failed to post reunited notice to Facebook:', e);
        return false;
      }
    });

    const twPromise = this._runIdempotentPost(item.id, 'twitter', 'reunited_notice', async () => {
      if (!twApiKey || !twApiSecret || !twAccessToken || !twAccessTokenSecret) {
        // P0: see the matching comment in postToTelegram above.
        if (process.env.NODE_ENV === 'production') {
          console.error('[SOCIAL SERVICE] FATAL: TWITTER_API_KEY/TWITTER_API_SECRET/TWITTER_ACCESS_TOKEN/TWITTER_ACCESS_TOKEN_SECRET missing in production. Refusing to report a fake success (reunited notice).');
          return false;
        }
        console.log(`\n=================== [SANDBOX TWITTER/X OUTBOX - REUNITED] ===================`);
        console.log(text);
        console.log(`===============================================================================\n`);
        return true;
      }
      try {
        const tweetUrl = 'https://api.twitter.com/2/tweets';
        const authHeader = buildOAuth1Header('POST', tweetUrl, {}, {
          apiKey: twApiKey,
          apiSecret: twApiSecret,
          accessToken: twAccessToken,
          accessTokenSecret: twAccessTokenSecret,
        });
        const res = await fetch(tweetUrl, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text.length > 280 ? text.slice(0, 277) + '\u2026' : text }),
        });
        if (!res.ok) {
          console.error('[SOCIAL SERVICE] Twitter/X reunited-notice error:', await res.json().catch(() => ({})));
          return false;
        }
        return true;
      } catch (e) {
        console.error('[SOCIAL SERVICE] Failed to post reunited notice to Twitter/X:', e);
        return false;
      }
    });

    const [tgResult, fbResult, twResult] = await Promise.all([tgPromise, fbPromise, twPromise]);
    console.log(`[SOCIAL SERVICE] Reunited notice completed for item ${item.id}. Telegram: ${tgResult ? 'Success' : 'Failed/Skipped'}, Facebook: ${fbResult ? 'Success' : 'Failed/Skipped'}, Twitter/X: ${twResult ? 'Success' : 'Failed/Skipped'}`);
  }
};
