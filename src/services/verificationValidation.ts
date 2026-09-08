import {
  getVerificationFields,
  VerificationField,
} from '../config/verificationProfiles';

// Authoritative server-side validation of Owner verification answers.
//
// The category profiles in src/config/verificationProfiles.ts are the single
// source of truth shared by the frontend form and this module. The frontend is
// untrusted, so allowed fields / required / type / maxLength are re-enforced
// here against the item's SERVER-KNOWN category before anything is persisted.
//
// Normalization: values are whitespace-trimmed only, so an Owner's evidence text
// is preserved verbatim for the agent to compare with the physical item.
// `lastDigits` additionally strips non-alphanumerics so the existing server-side
// OCR comparison can match letter/number document numbers (e.g. "KX123A").

const FORBIDDEN_KEY_PATTERNS: RegExp[] = [
  /cvv/i,
  /cardverification/i,
  /cardcode/i,
  /(^|[_-])pin$/i,
  /securitycode/i,
  /pan$/i,
  /fullcardnumber/i,
  /cardnumber/i,
  /password/i,
  /passcode/i,
  /secret/i,
  /token/i,
  /otp/i,
];

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

// Keys that may exist in claims stored before the profile refactor. They can be
// read back for agent evidence but are never accepted for new submissions.
export const LEGACY_EVIDENCE_KEYS = [
  'lostDetails',
  'lastNameOnDoc',
  'whereLost',
  'colorDetail',
];

export interface AnswerValidationSuccess {
  ok: true;
  sanitized: Record<string, string>;
}

export interface AnswerValidationFailure {
  ok: false;
  error: string;
}

export type AnswerValidation = AnswerValidationSuccess | AnswerValidationFailure;

// The project compiles WITHOUT `strict` (tsconfig.json omits it). Under
// strictNullChecks:false, TypeScript's truthiness/negation narrowing of a
// boolean-literal discriminant is unreliable — `if (!validation.ok)` fails to
// exclude the ok:true member. These explicit user-defined type guards make the
// union narrowing correct regardless of strict mode, without weakening the
// union or resorting to `any`.
export function isAnswerValidationSuccess(
  validation: AnswerValidation
): validation is AnswerValidationSuccess {
  return validation.ok === true;
}

export function isAnswerValidationFailure(
  validation: AnswerValidation
): validation is AnswerValidationFailure {
  return validation.ok === false;
}

function fail(message: string): AnswerValidationFailure {
  return { ok: false, error: message };
}

export function validateVerificationAnswers(
  categoryId: string,
  submitted: unknown
): AnswerValidation {
  const fields = getVerificationFields(categoryId);

  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
    return fail('Verification answers must be a JSON object.');
  }

  const raw = submitted as Record<string, unknown>;
  const allowed = new Map<string, VerificationField>(
    fields.map((field) => [field.key, field])
  );
  const sanitized: Record<string, string> = {};

  for (const key of Object.keys(raw)) {
    if (isForbiddenKey(key)) {
      return fail('Verification answers contain a disallowed field.');
    }
    const field = allowed.get(key);
    if (!field) {
      return fail(`Unknown verification field for this item type: "${key}".`);
    }
    const value = raw[key];
    if (typeof value !== 'string') {
      return fail(`Verification field "${key}" must be a single text value.`);
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      if (field.required) {
        return fail(`Required verification field is missing: "${key}".`);
      }
      continue; // empty optional fields are dropped rather than stored
    }
    if (field.maxLength && trimmed.length > field.maxLength) {
      return fail(`Verification field "${key}" exceeds the maximum length.`);
    }
    if (key === 'lastDigits') {
      const cleaned = trimmed.replace(/[^A-Z0-9]/gi, '');
      if (cleaned.length === 0 || cleaned.length > 4) {
        return fail('The last document digits must be between 1 and 4 characters.');
      }
    }
    sanitized[key] = trimmed;
  }

  for (const field of fields) {
    if (field.required && !(field.key in sanitized)) {
      return fail(`Required verification field is missing: "${field.key}".`);
    }
  }

  return { ok: true, sanitized };
}

// Builds the minimal operational evidence object returned to an assigned Agent.
// Only keys belonging to the item's category profile (plus legacy keys that
// predate the profile system) are included — never arbitrary stored metadata.
export function toAgentVerificationEvidence(
  categoryId: string,
  answers: unknown
): Record<string, string> {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return {};
  }
  const source = answers as Record<string, unknown>;
  const allowedKeys = new Set<string>([
    ...getVerificationFields(categoryId).map((field) => field.key),
    ...LEGACY_EVIDENCE_KEYS,
  ]);
  const evidence: Record<string, string> = {};
  for (const key of Object.keys(source)) {
    if (allowedKeys.has(key) && typeof source[key] === 'string') {
      const value = source[key].trim();
      if (value) evidence[key] = value;
    }
  }
  return evidence;
}
