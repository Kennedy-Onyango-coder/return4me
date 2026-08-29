import { describe, it, expect } from 'vitest';
import { maskPublicName, maskPublicDocumentNumber, safePublicLocation, buildSafePublicClues } from '../publicRecognition';

describe('maskPublicName', () => {
  it('masks a standard two-part name exactly per spec: "Kennedy Onyango" -> "K****** O******"', () => {
    expect(maskPublicName('Kennedy Onyango')).toBe('K****** O******');
  });

  it('handles a one-name person', () => {
    expect(maskPublicName('Madonna')).toBe('M******');
  });

  it('handles a very short name safely without throwing or exposing more than the mask allows', () => {
    expect(maskPublicName('Jo')).toBe('J*');
    expect(maskPublicName('A')).toBe('A');
  });

  it('never exposes a third or later name part, even masked', () => {
    const result = maskPublicName('Kennedy Otieno Onyango Junior');
    expect(result).toBe('K****** O*****');
    expect(result).not.toMatch(/Onyango|Junior/i);
    expect(result?.split(' ').length).toBe(2);
  });

  it('handles missing names safely', () => {
    expect(maskPublicName(null)).toBeNull();
    expect(maskPublicName(undefined)).toBeNull();
    expect(maskPublicName('')).toBeNull();
    expect(maskPublicName('   ')).toBeNull();
  });

  it('never exposes the full original name as a literal substring of the result', () => {
    const result = maskPublicName('Kennedy Onyango');
    expect(result).not.toContain('ennedy');
    expect(result).not.toContain('nyango');
  });

  it('collapses extra internal whitespace correctly', () => {
    expect(maskPublicName('Kennedy    Onyango')).toBe('K****** O******');
  });
});

describe('maskPublicDocumentNumber', () => {
  it('national_id style shows first 2 digits only: "12345678" -> "12******"', () => {
    expect(maskPublicDocumentNumber('12345678', 'national_id')).toBe('12******');
  });

  it('passport style shows first character only: "A1234567" -> "A*******"', () => {
    expect(maskPublicDocumentNumber('A1234567', 'passport')).toBe('A*******');
  });

  it('driving_licence style shows first character only', () => {
    expect(maskPublicDocumentNumber('KX123456', 'driving_licence')).toBe('K*******');
  });

  it('card style shows only the last 4 digits, PCI-style: "•••• 4821"', () => {
    expect(maskPublicDocumentNumber('4111111111114821', 'card')).toBe('•••• 4821');
  });

  it('"none" style never shows a clue at all, regardless of input', () => {
    expect(maskPublicDocumentNumber('12345678', 'none')).toBeNull();
  });

  it('generic (default/unknown) style shows first character only', () => {
    expect(maskPublicDocumentNumber('XYZ987654', 'generic')).toBe('X********');
    expect(maskPublicDocumentNumber('XYZ987654', 'some-future-unmapped-style')).toBe('X********');
  });

  it('never exposes the full number for any style', () => {
    for (const style of ['national_id', 'passport', 'driving_licence', 'card', 'generic']) {
      const result = maskPublicDocumentNumber('123456789', style);
      expect(result).not.toBe('123456789');
    }
  });

  it('never exposes CVV/PIN/security-code-shaped short numbers beyond what the style allows', () => {
    // A short input still gets masked, never shown in full.
    expect(maskPublicDocumentNumber('123', 'card')).not.toBe('123');
    expect(maskPublicDocumentNumber('12', 'national_id')).not.toBe('12');
  });

  it('handles missing document numbers safely', () => {
    expect(maskPublicDocumentNumber(null, 'national_id')).toBeNull();
    expect(maskPublicDocumentNumber(undefined, 'national_id')).toBeNull();
    expect(maskPublicDocumentNumber('', 'national_id')).toBeNull();
  });
});

describe('safePublicLocation', () => {
  it('keeps an "Area, Town" style location as-is', () => {
    expect(safePublicLocation('Eastleigh, Nairobi')).toBe('Eastleigh, Nairobi');
  });

  it('reduces a multi-comma address down to area + last segment only', () => {
    expect(safePublicLocation('Plot 42, Jogoo Road, Eastleigh, Nairobi')).toBe('Plot 42, Nairobi');
  });

  it('never exposes an exact street address or house number pattern beyond what was given', () => {
    // The function doesn't invent new info — it just never expands a
    // short free-text description into something more specific than given.
    const result = safePublicLocation('Near the blue gate, House No. 14, Off Argwings Kodhek Road, Kilimani, Nairobi');
    expect(result.split(',').length).toBeLessThanOrEqual(2);
  });

  it('falls back to a short word-limited snippet for a single free-text phrase', () => {
    const result = safePublicLocation('somewhere near the big roundabout in town');
    expect(result.split(/\s+/).length).toBeLessThanOrEqual(3);
  });

  it('handles missing location safely', () => {
    expect(safePublicLocation(null)).toBe('Kenya');
    expect(safePublicLocation(undefined)).toBe('Kenya');
    expect(safePublicLocation('')).toBe('Kenya');
  });
});

describe('buildSafePublicClues', () => {
  it('sensitive item: uses verified fields, produces masked name + masked number + safe location', () => {
    const clues = buildSafePublicClues(
      {
        is_sensitive_document: true,
        verified_name: 'Kennedy Onyango',
        verified_document_number: '12345678',
        verified_found_area: 'Eastleigh, Nairobi',
      },
      { public_clue_style: 'national_id' }
    );
    expect(clues.nameClue).toBe('K****** O******');
    expect(clues.documentNumberClue).toBe('12******');
    expect(clues.location).toBe('Eastleigh, Nairobi');
  });

  it('non-sensitive item: never produces a name or document clue, regardless of what data is present', () => {
    const clues = buildSafePublicClues(
      {
        is_sensitive_document: false,
        verified_name: 'Should Never Appear',
        verified_document_number: '99999999',
        verified_found_area: 'Westlands, Nairobi',
      },
      { public_clue_style: 'generic' }
    );
    expect(clues.nameClue).toBeNull();
    expect(clues.documentNumberClue).toBeNull();
    expect(clues.location).toBe('Westlands, Nairobi');
  });

  it('falls back to the original Finder fields only defensively if verified_* is still null', () => {
    const clues = buildSafePublicClues(
      {
        is_sensitive_document: true,
        verified_name: null,
        verified_document_number: null,
        verified_found_area: null,
        ocr_extracted_name: 'Fallback Name',
        ocr_extracted_number: '87654321',
        location_description: 'Kibera, Nairobi',
      },
      { public_clue_style: 'national_id' }
    );
    expect(clues.nameClue).toBe('F******* N***');
    expect(clues.documentNumberClue).toBe('87******');
    expect(clues.location).toBe('Kibera, Nairobi');
  });

  it('the resulting clues are never sufficient to reconstruct the original full values', () => {
    const clues = buildSafePublicClues(
      {
        is_sensitive_document: true,
        verified_name: 'Kennedy Onyango',
        verified_document_number: '12345678',
        verified_found_area: 'Eastleigh, Nairobi',
      },
      { public_clue_style: 'national_id' }
    );
    expect(clues.nameClue).not.toContain('Kennedy');
    expect(clues.nameClue).not.toContain('Onyango');
    expect(clues.documentNumberClue).not.toBe('12345678');
    expect(clues.documentNumberClue).not.toContain('345678');
  });
});
