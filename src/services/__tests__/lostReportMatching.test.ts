import { describe, it, expect } from 'vitest';
import {
  normalizeForMatch,
  tokenizeForMatch,
  detectCountiesInText,
  evaluateLostReportAgainstItem,
  decideCandidate,
  selectLostReportCandidates,
  MIN_DISTINGUISHING_MATCHES,
  TIME_EARLY_TOLERANCE_MS,
  TIME_REPORTING_LAG_MS,
  type LostReportMatchSignals,
} from '../lostReportMatching';

// ---------------------------------------------------------------------------
// Phase 9B — unit tests for the deterministic matching engine.
//
// The engine is PURE (no I/O, no clock reads, no randomness), so these tests
// drive it directly with hand-built rows. That is the only way to pin the
// false-positive policy exactly: each "must NOT match" case below is a
// deliberate statement about what the engine refuses to infer.
// ---------------------------------------------------------------------------

// A fixed time window ("I lost it between 11am and 2pm") and fixed timestamps,
// so nothing depends on the wall clock.
const WINDOW_FROM = '2026-03-10T11:00:00.000Z';
const WINDOW_TO = '2026-03-10T14:00:00.000Z';
const FOUND_IN_WINDOW = '2026-03-10T13:30:00.000Z';

function lostReport(overrides: Record<string, any> = {}) {
  return {
    id: 'LR-UNIT-1',
    customer_id: 'CUS-UNIT-1',
    category_id: 'smartphone',
    status: 'active',
    county: 'Nairobi City',
    location_area: 'Westlands',
    location_landmark: null,
    lost_at_from: WINDOW_FROM,
    lost_at_to: WINDOW_TO,
    brand: null,
    model: null,
    colour: null,
    material: null,
    description: null,
    distinctive_marks: null,
    document_type: null,
    document_number_hash: null,
    ...overrides,
  } as any;
}

function foundItem(overrides: Record<string, any> = {}) {
  return {
    id: 'R4M-UNIT-1',
    category_id: 'smartphone',
    photo_url: 'photo.jpg',
    is_sensitive_document: false,
    isDescriptionOnly: false,
    document_name_fuzzy: 'Simu',
    location_description: 'Sarit Centre, Westlands, Nairobi',
    description: 'Black Samsung phone with a cracked screen',
    document_number_hash: null,
    created_at: FOUND_IN_WINDOW,
    status: 'at_agent',
    flaggedForReview: false,
    ...overrides,
  } as any;
}

function signalsFor(lost: any, item: any): LostReportMatchSignals {
  return evaluateLostReportAgainstItem(lost, item).signals;
}

describe('normalization is deterministic and shape-tolerant', () => {
  it('lowercases, strips punctuation/accents and collapses whitespace', () => {
    expect(normalizeForMatch('  Nairobi   County.  ')).toBe('nairobi county');
    expect(normalizeForMatch("Murang'a")).toBe('murang a');
    expect(normalizeForMatch('M-Pesa / Till')).toBe('m pesa till');
    expect(normalizeForMatch(null)).toBe('');
    expect(normalizeForMatch(12345)).toBe('');
  });

  it('tokenizes to a stable list', () => {
    expect(tokenizeForMatch('Sarit Centre, Westlands')).toEqual(['sarit', 'centre', 'westlands']);
    expect(tokenizeForMatch('')).toEqual([]);
  });
});

describe('canonical county detection from free text', () => {
  it('finds a canonical county from a normal address', () => {
    expect([...detectCountiesInText('Moi Avenue, Nairobi')]).toContain('Nairobi City');
    expect([...detectCountiesInText('Nairobi County')]).toContain('Nairobi City');
    expect([...detectCountiesInText('along Mombasa Road')]).toContain('Mombasa');
  });

  it('handles the two-word county names by requiring ALL distinctive words', () => {
    expect([...detectCountiesInText('Kitale, Trans Nzoia')]).toContain('Trans Nzoia');
    // "Trans" alone must not be enough.
    expect([...detectCountiesInText('trans street')]).not.toContain('Trans Nzoia');
    expect([...detectCountiesInText('Westlands, Nairobi')]).not.toContain('West Pokot');
  });

  it('does not invent a county from a town that is not a county', () => {
    // Kitengela is in Kajiado but is not itself a county name.
    expect(detectCountiesInText('Kitengela town').size).toBe(0);
  });

  it('never reports a county the text does not name', () => {
    expect(detectCountiesInText('Sarit Centre').size).toBe(0);
  });
});

describe('threshold policy is pinned', () => {
  it('requires two distinguishing matches and a location/time anchor', () => {
    expect(MIN_DISTINGUISHING_MATCHES).toBe(2);
  });

  it('bounds the temporal tolerances', () => {
    expect(TIME_EARLY_TOLERANCE_MS).toBe(6 * 60 * 60 * 1000);
    expect(TIME_REPORTING_LAG_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('category gating eliminates before anything else is considered', () => {
  it('a different category is never a candidate, even with everything else agreeing', () => {
    const lost = lostReport({ category_id: 'national-id', colour: 'Black' });
    const item = foundItem({ category_id: 'smartphone' });
    const result = evaluateLostReportAgainstItem(lost, item);
    expect(result.signals.category_match).toBe('mismatch');
    expect(result.candidate).toBe(false);
    expect(result.reason).toBe('category_mismatch');
  });

  it('the same category is a match (no alias/equivalence is invented)', () => {
    expect(signalsFor(lostReport(), foundItem()).category_match).toBe('match');
    // 'laptop' vs 'smartphone' — both electronics, still different categories.
    expect(signalsFor(lostReport({ category_id: 'laptop' }), foundItem()).category_match).toBe('mismatch');
  });

  it('prefers the agent-verified category when one exists', () => {
    const lost = lostReport({ category_id: 'laptop' });
    const item = foundItem({ category_id: 'smartphone', verified_category_id: 'laptop' });
    expect(signalsFor(lost, item).category_match).toBe('match');
  });
});

describe('protected identifier handling', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  it('an exact hash agreement makes a candidate on its own strength', () => {
    const lost = lostReport({ document_number_hash: HASH_A, county: 'Nairobi City' });
    // Deliberately hostile surroundings: a different area and a late item, so
    // only the identifier is carrying this.
    const item = foundItem({ document_number_hash: HASH_A, location_description: 'Kisumu', created_at: '2026-04-30T10:00:00.000Z' });
    const result = evaluateLostReportAgainstItem(lost, item);
    expect(result.signals.identifier_match).toBe('match');
    expect(result.candidate).toBe(true);
    expect(result.reason).toBe('exact_identifier');
  });

  it('a MISMATCHING hash eliminates the candidate despite strong supporting signals', () => {
    const lost = lostReport({ document_number_hash: HASH_A });
    const item = foundItem({ document_number_hash: HASH_B, description: 'Black Samsung phone Westlands cracked' });
    const result = evaluateLostReportAgainstItem(lost, item);
    expect(result.signals.identifier_match).toBe('mismatch');
    expect(result.candidate).toBe(false);
    expect(result.reason).toBe('identifier_mismatch');
  });

  it('an identifier present on only ONE side is UNKNOWN, not a mismatch', () => {
    expect(signalsFor(lostReport({ document_number_hash: HASH_A }), foundItem()).identifier_match).toBe('unknown');
    expect(signalsFor(lostReport(), foundItem({ document_number_hash: HASH_A })).identifier_match).toBe('unknown');
    // ...and UNKNOWN must not eliminate: the pair is still a candidate.
    expect(evaluateLostReportAgainstItem(lostReport({ document_number_hash: HASH_A }), foundItem()).candidate).toBe(true);
  });

  it('never puts the hash into the produced evidence', () => {
    const lost = lostReport({ document_number_hash: HASH_A });
    const item = foundItem({ document_number_hash: HASH_A });
    const serialized = JSON.stringify(evaluateLostReportAgainstItem(lost, item));
    expect(serialized).not.toContain(HASH_A);
    expect(serialized).not.toContain('document_number');
  });
});

describe('document_type can corroborate but never eliminate', () => {
  it('agreeing with the item category is a corroborating match', () => {
    const lost = lostReport({ document_type: 'smartphone' });
    expect(signalsFor(lost, foundItem()).document_type_match).toBe('match');
  });

  it("a reporter declaring an identifier CLASS ('imei') is NOT eliminated", () => {
    const lost = lostReport({ document_type: 'imei' });
    const item = foundItem();
    const result = evaluateLostReportAgainstItem(lost, item);
    expect(result.signals.document_type_match).toBe('unknown');
    // Critically: it must not be read as a contradiction.
    expect(result.signals.document_type_match).not.toBe('mismatch');
    expect(result.candidate).toBe(true);
  });

  it('is UNKNOWN when the report declares no document type', () => {
    expect(signalsFor(lostReport(), foundItem()).document_type_match).toBe('unknown');
  });
});

describe('time window handling', () => {
  it('an item recorded inside the lost window matches', () => {
    expect(signalsFor(lostReport(), foundItem({ created_at: FOUND_IN_WINDOW })).time_match).toBe('match');
  });

  it('an item recorded shortly after the window (reporting lag) still matches', () => {
    expect(signalsFor(lostReport(), foundItem({ created_at: '2026-03-14T09:00:00.000Z' })).time_match).toBe('match');
  });

  it('an item recorded just before the window matches within the early tolerance', () => {
    expect(signalsFor(lostReport(), foundItem({ created_at: '2026-03-10T08:00:00.000Z' })).time_match).toBe('match');
  });

  it('an item recorded well BEFORE the loss is a mismatch and eliminates', () => {
    const item = foundItem({ created_at: '2026-03-09T00:00:00.000Z' });
    const result = evaluateLostReportAgainstItem(lostReport(), item);
    expect(result.signals.time_match).toBe('mismatch');
    expect(result.candidate).toBe(false);
    expect(result.reason).toBe('found_before_lost');
  });

  it('an item recorded long AFTER the window is UNKNOWN, not a mismatch', () => {
    const item = foundItem({ created_at: '2026-05-01T09:00:00.000Z' });
    expect(signalsFor(lostReport(), item).time_match).toBe('unknown');
  });

  it('treats "long after" as unknown rather than eliminating, so location can still carry it', () => {
    const lost = lostReport({ brand: 'Samsung', colour: 'Black' });
    const item = foundItem({ created_at: '2026-05-01T09:00:00.000Z' });
    const result = evaluateLostReportAgainstItem(lost, item);
    expect(result.signals.time_match).toBe('unknown');
    expect(result.signals.location_match).toBe('match');
    expect(result.candidate).toBe(true);
  });

  it('is UNKNOWN when the item has no usable timestamp', () => {
    expect(signalsFor(lostReport(), foundItem({ created_at: null })).time_match).toBe('unknown');
  });
});

describe('location matching tolerates text differences but never invents geography', () => {
  it('matches a county named in the item location text', () => {
    expect(signalsFor(lostReport(), foundItem({ location_description: 'Moi Avenue, Nairobi' })).location_match).toBe('match');
  });

  it('matches on a shared area/landmark token even without a county name', () => {
    // The item location names the same neighbourhood but NO county at all.
    expect(signalsFor(lostReport(), foundItem({ location_description: 'Westlands stage' })).location_match).toBe('match');
    // A landmark recorded on the report also counts when it appears in the item text.
    const withLandmark = lostReport({ location_landmark: 'Sarit Centre' });
    expect(signalsFor(withLandmark, foundItem({ location_description: 'car park near sarit' })).location_match).toBe('match');
  });

  it('is UNKNOWN when neither side gives usable location information', () => {
    const lost = lostReport({ location_area: 'X', county: '' });
    expect(signalsFor(lost, foundItem({ location_description: 'unknown', verified_found_area: null })).location_match).toBe('unknown');
  });

  it('ELIMINATES when the item names a different canonical Kenyan county', () => {
    const item = foundItem({ location_description: 'Mombasa, Digo Road' });
    const result = evaluateLostReportAgainstItem(lostReport(), item);
    expect(result.signals.location_match).toBe('mismatch');
    expect(result.candidate).toBe(false);
    expect(result.reason).toBe('location_county_mismatch');
  });

  it('does NOT eliminate for a town that merely lies in a neighbouring county name', () => {
    // "Kitengela" is not a county name, so no conflict is declared.
    const item = foundItem({ location_description: 'Kitengela stage', verified_found_area: null });
    expect(signalsFor(lostReport(), item).location_match).toBe('unknown');
  });

  it('prefers the agent-verified found area when one exists', () => {
    const lost = lostReport({ county: 'Kisumu', location_area: 'Kondele' });
    const item = foundItem({ location_description: 'Mombasa Road, Nairobi', verified_found_area: 'Kondele, Kisumu' });
    expect(signalsFor(lost, item).location_match).toBe('match');
  });
});

describe('structured attributes corroborate but never contradict', () => {
  it('finds brand, colour and model inside the item text', () => {
    const lost = lostReport({ brand: 'Samsung', colour: 'Black', model: 'Galaxy A54' });
    const item = foundItem({ description: 'Black Samsung Galaxy A54 phone, cracked screen' });
    const signals = signalsFor(lost, item);
    expect(signals.brand_match).toBe('match');
    expect(signals.colour_match).toBe('match');
    expect(signals.model_match).toBe('match');
  });

  it('returns UNKNOWN (never MISMATCH) when the item text simply omits the attribute', () => {
    const lost = lostReport({ brand: 'Samsung', colour: 'Black' });
    const item = foundItem({ description: 'A phone in a blue case' });
    const signals = signalsFor(lost, item);
    expect(signals.brand_match).toBe('unknown');
    expect(signals.colour_match).toBe('unknown');
  });

  it('treats placeholder attribute values as absent', () => {
    const lost = lostReport({ brand: 'N/A', colour: 'unknown', material: '  ' });
    const signals = signalsFor(lost, foundItem());
    expect(signals.brand_match).toBe('unknown');
    expect(signals.colour_match).toBe('unknown');
    expect(signals.material_match).toBe('unknown');
  });

  it('requires EVERY token of a multi-word attribute to be present', () => {
    const lost = lostReport({ colour: 'Navy Blue' });
    expect(signalsFor(lost, foundItem({ description: 'a navy blue jacket' })).colour_match).toBe('match');
    expect(signalsFor(lost, foundItem({ description: 'a navy jacket' })).colour_match).toBe('unknown');
  });
});

function signalMatrix(overrides: Partial<LostReportMatchSignals>): LostReportMatchSignals {
  return {
    category_match: 'match',
    identifier_match: 'unknown',
    document_type_match: 'unknown',
    brand_match: 'unknown',
    model_match: 'unknown',
    colour_match: 'unknown',
    material_match: 'unknown',
    location_match: 'unknown',
    time_match: 'unknown',
    text_signal: 'unknown',
    ...overrides,
  };
}

describe('free-text evidence refuses generic words', () => {
  it('shares no evidence when both texts contain only kind-words', () => {
    const lost = lostReport({ description: 'black phone bag wallet', distinctive_marks: 'black' });
    const item = foundItem({ description: 'black phone bag wallet', document_name_fuzzy: 'item' });
    expect(signalsFor(lost, item).text_signal).toBe('unknown');
  });

  it('counts a real coincidence of two significant words as a signal', () => {
    const lost = lostReport({ description: 'cracked screen with a lion sticker' });
    const item = foundItem({ description: 'phone with cracked screen' });
    expect(signalsFor(lost, item).text_signal).toBe('match');
  });

  it('does not count a SINGLE shared significant word as a signal', () => {
    const lost = lostReport({ description: 'cracked screen' });
    const item = foundItem({ description: 'cracked glass' });
    expect(signalsFor(lost, item).text_signal).toBe('unknown');
  });
});

describe('FALSE-POSITIVE CONTROLS (the cases that must NOT match)', () => {
  it('a lost "black Samsung phone" does NOT match a same-model phone in ANOTHER county', () => {
    const lost = lostReport({
      brand: 'Samsung', colour: 'Black',
      description: 'black samsung phone', county: 'Nairobi City',
    });
    const item = foundItem({
      description: 'Black Samsung phone, cracked screen',
      location_description: 'Mombasa, Digo Road',
      created_at: '2026-04-01T09:00:00.000Z',
    });
    const result = evaluateLostReportAgainstItem(lost, item);
    // Brand AND colour AND shared description all agree — and it is STILL
    // rejected, because the item is in a different county.
    expect(result.signals.brand_match).toBe('match');
    expect(result.signals.colour_match).toBe('match');
    expect(result.candidate).toBe(false);
  });

  it('brand + colour agreement ALONE is not enough (no location or time anchor)', () => {
    const lost = lostReport({
      brand: 'Samsung', colour: 'Black', county: '', location_area: 'Town',
    });
    const item = foundItem({
      description: 'Black Samsung phone',
      location_description: 'stage area',
      created_at: '2026-05-01T09:00:00.000Z',
    });
    const result = evaluateLostReportAgainstItem(lost, item);
    expect(result.signals.brand_match).toBe('match');
    expect(result.signals.colour_match).toBe('match');
    expect(result.signals.location_match).toBe('unknown');
    expect(result.signals.time_match).toBe('unknown');
    expect(result.candidate).toBe(false);
    expect(result.reason).toBe('insufficient_evidence');
  });

  it('a lost "black wallet" does NOT match every black wallet', () => {
    const lost = lostReport({ category_id: 'empty-wallet', colour: 'Black', county: '', location_area: 'Town' });
    const item = foundItem({
      category_id: 'empty-wallet',
      description: 'black leather wallet',
      location_description: 'stage area',
      created_at: '2026-05-01T09:00:00.000Z',
    });
    const result = evaluateLostReportAgainstItem(lost, item);
    expect(result.signals.colour_match).toBe('match');
    expect(result.candidate).toBe(false);
  });

  it('one weak signal is never enough', () => {
    const decision = decideCandidate(signalMatrix({ text_signal: 'match' }), 5, 6);
    expect(decision.candidate).toBe(false);
    expect(decision.reason).toBe('insufficient_evidence');
  });

  it('several supporting signals with no anchor are still not enough', () => {
    const decision = decideCandidate(
      signalMatrix({ text_signal: 'match', colour_match: 'match', material_match: 'match' }),
      20, 8,
    );
    expect(decision.candidate).toBe(false);
  });
});

describe('decision rule precedence', () => {
  it('category mismatch overrides every other signal', () => {
    const matrix = signalMatrix({
      category_match: 'mismatch', identifier_match: 'match', location_match: 'match',
      time_match: 'match', brand_match: 'match', colour_match: 'match', text_signal: 'match',
    });
    const decision = decideCandidate(matrix, 999, 10);
    expect(decision.candidate).toBe(false);
    expect(decision.reason).toBe('category_mismatch');
  });

  it('identifier mismatch overrides every supporting signal', () => {
    const matrix = signalMatrix({
      identifier_match: 'mismatch', location_match: 'match', time_match: 'match',
      brand_match: 'match', colour_match: 'match', text_signal: 'match',
    });
    const decision = decideCandidate(matrix, 999, 10);
    expect(decision.candidate).toBe(false);
    expect(decision.reason).toBe('identifier_mismatch');
  });

  it('identifier agreement outranks a contradictory location/time', () => {
    const decision = decideCandidate(
      signalMatrix({ identifier_match: 'match', location_match: 'mismatch', time_match: 'mismatch' }),
      100, 0,
    );
    expect(decision.candidate).toBe(true);
    expect(decision.reason).toBe('exact_identifier');
  });

  it('eliminations run location, then time, then evidence', () => {
    expect(decideCandidate(signalMatrix({ location_match: 'mismatch' }), 0, 0).reason).toBe('location_county_mismatch');
    expect(decideCandidate(signalMatrix({ time_match: 'mismatch' }), 0, 0).reason).toBe('found_before_lost');
    expect(decideCandidate(signalMatrix({ location_match: 'match' }), 15, 0).reason).toBe('insufficient_evidence');
  });

  it('an anchor plus one more distinguishing signal is enough', () => {
    expect(decideCandidate(signalMatrix({ location_match: 'match', brand_match: 'match' }), 27, 0).candidate).toBe(true);
    expect(decideCandidate(signalMatrix({ time_match: 'match', model_match: 'match' }), 22, 0).candidate).toBe(true);
    expect(decideCandidate(signalMatrix({ location_match: 'match', text_signal: 'match' }), 25, 5).candidate).toBe(true);
  });

  it('an anchor ALONE (a single distinguishing signal) is not enough', () => {
    expect(decideCandidate(signalMatrix({ location_match: 'match' }), 15, 0).candidate).toBe(false);
    expect(decideCandidate(signalMatrix({ time_match: 'match' }), 10, 0).candidate).toBe(false);
  });
});

describe('candidate selection is conservative and deterministic', () => {
  it('returns only accepted candidates', () => {
    const lost = lostReport();
    const matching = foundItem({ id: 'R4M-KEEP-1' });
    const wrongCategory = foundItem({ id: 'R4M-DROP-1', category_id: 'laptop' });
    const candidates = selectLostReportCandidates(lost, [matching, wrongCategory]);
    expect(candidates.map((c) => c.item.id)).toEqual(['R4M-KEEP-1']);
  });

  it('is deterministic across repeated runs', () => {
    const lost = lostReport();
    const items = [
      foundItem({ id: 'R4M-B' }),
      foundItem({ id: 'R4M-A' }),
      foundItem({ id: 'R4M-C' }),
    ];
    const first = selectLostReportCandidates(lost, items).map((c) => c.item.id);
    const second = selectLostReportCandidates(lost, [...items].reverse()).map((c) => c.item.id);
    expect(first).toEqual(second);
  });

  it('orders by internal score first (identifier beats corroboration)', () => {
    const lost = lostReport({ document_number_hash: 'f'.repeat(64) });
    const corroborated = foundItem({ id: 'R4M-CORROB' });
    const identifier = foundItem({ id: 'R4M-IDENT', document_number_hash: 'f'.repeat(64) });
    const candidates = selectLostReportCandidates(lost, [corroborated, identifier]);
    expect(candidates[0].item.id).toBe('R4M-IDENT');
    expect(candidates[0].evaluation.reason).toBe('exact_identifier');
  });

  it('ignores malformed entries and de-duplicates repeated item ids', () => {
    const lost = lostReport();
    const candidates = selectLostReportCandidates(lost, [
      null, undefined, { id: 123 }, foundItem({ id: 'R4M-DUP' }), foundItem({ id: 'R4M-DUP' }),
    ] as any[]);
    expect(candidates.map((c) => c.item.id)).toEqual(['R4M-DUP']);
  });

  it('handles an empty or absent candidate set', () => {
    expect(selectLostReportCandidates(lostReport(), [])).toEqual([]);
    expect(selectLostReportCandidates(lostReport(), null as any)).toEqual([]);
  });
});




