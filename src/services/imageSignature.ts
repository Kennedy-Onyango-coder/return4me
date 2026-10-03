// Shared image-signature + name-masking helpers.
//
// P2-A1 — MECHANICAL MOVE. Both functions previously lived as module-local
// definitions near the bottom of server.ts. They are needed by the extracted
// Finder report routes (routes/finderReport.ts) AND still by several inline
// server.ts routes, so they were MOVED here verbatim rather than copied, in the
// same spirit as hashDocument -> services/documentHash.ts and getRoughArea ->
// services/publicItemView.ts. One implementation, no second copy to drift.
//
// DO NOT "IMPROVE" THESE. They are byte-identical to the definitions they
// replaced, including maskName's deliberate differences from the similarly
// named export in services/social.ts (no `if (!name) return '***'` guard, no
// .trim()). Swapping one for the other would change the masked string actually
// persisted against an item, so the two must stay distinct.

/**
 * True when the supplied string decodes to a real JPEG/PNG/WEBP/HEIC image.
 * Fails closed: any decode error returns false.
 */
export function isValidImageSignature(base64Str: string): boolean {
  try {
    if (!base64Str) return false;
    const base64Data = base64Str.includes(';base64,') ? base64Str.split(';base64,')[1] : base64Str;
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length < 4) return false;

    // JPEG
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return true;
    }
    // PNG
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return true;
    }
    // WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WEBP') {
      return true;
    }
    // HEIC
    if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
      const brand = buffer.toString('ascii', 8, 12).toLowerCase();
      if (brand.startsWith('hei') || brand.startsWith('hev') || brand.startsWith('mif') || brand.startsWith('msf')) {
        return true;
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Masks each word of a name, keeping the first and last character of words
 * longer than two characters.
 */
export function maskName(name: string): string {
  const parts = name.split(/\s+/);
  const maskedParts = parts.map(part => {
    if (part.length <= 2) return part;
    return part[0] + '*'.repeat(part.length - 2) + part[part.length - 1];
  });
  return maskedParts.join(' ');
}
