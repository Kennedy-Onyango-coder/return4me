/**
 * CATEGORY-SPECIFIC VERIFICATION PROFILES
 * ========================================
 *
 * Declarative configuration that drives which verification fields an Owner
 * sees based on the category of the item they are claiming.
 *
 * Architecture: CATEGORY -> VERIFICATION PROFILE -> FIELDS -> VALIDATION
 *
 * SECURITY NOTE: Owner verification answers are private. They must NEVER
 * appear in public listings, social media, Finder/Agent dashboards (unless
 * operationally necessary), URLs, analytics, console logs, or error messages.
 */

export type VerificationFieldType =
  | 'text'
  | 'textarea'
  | 'tel'
  | 'email'
  | 'file'
  | 'checkbox';

export interface VerificationField {
  key: string;
  labelKey: string;
  type: VerificationFieldType;
  required: boolean;
  placeholderKey?: string;
  sensitive?: boolean;
  maxLength?: number;
  helpTextKey?: string;
}

export const verificationProfiles: Record<string, VerificationField[]> = {
  // =====================
  // DOCUMENTS (sensitive)
  // =====================
  'national-id': [
    { key: 'lastDigits', labelKey: 'verify.lastDigits', type: 'text', required: true, placeholderKey: 'verify.lastDigitsPlaceholder', sensitive: true, maxLength: 4, helpTextKey: 'verify.lastDigitsHelp' },
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
    { key: 'lostLocation', labelKey: 'verify.lostLocation', type: 'text', required: false, placeholderKey: 'verify.lostLocationPlaceholder' },
  ],
  'passport': [
    { key: 'lastDigits', labelKey: 'verify.lastDigits', type: 'text', required: true, placeholderKey: 'verify.passportDigitsPlaceholder', sensitive: true, maxLength: 4, helpTextKey: 'verify.lastDigitsHelp' },
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
    { key: 'nationality', labelKey: 'verify.nationality', type: 'text', required: false, placeholderKey: 'verify.nationalityPlaceholder' },
  ],
  'driving-licence': [
    { key: 'lastDigits', labelKey: 'verify.lastDigits', type: 'text', required: true, placeholderKey: 'verify.lastDigitsPlaceholder', sensitive: true, maxLength: 4, helpTextKey: 'verify.lastDigitsHelp' },
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
    { key: 'lostLocation', labelKey: 'verify.lostLocation', type: 'text', required: false, placeholderKey: 'verify.lostLocationPlaceholder' },
  ],
  'atm-credit-card': [
    { key: 'lastDigits', labelKey: 'verify.lastDigits', type: 'text', required: true, placeholderKey: 'verify.cardDigitsPlaceholder', sensitive: true, maxLength: 4, helpTextKey: 'verify.cardDigitsHelp' },
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
        { key: 'bankName', labelKey: 'verify.bankName', type: 'text', required: false, placeholderKey: 'verify.bankNamePlaceholder' },
  ],
  'kra-nhif-nssf': [
    { key: 'lastDigits', labelKey: 'verify.lastDigits', type: 'text', required: true, placeholderKey: 'verify.lastDigitsPlaceholder', sensitive: true, maxLength: 4, helpTextKey: 'verify.lastDigitsHelp' },
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
  ],
  'vehicle-logbook': [
    { key: 'plateNumber', labelKey: 'verify.plateNumber', type: 'text', required: true, placeholderKey: 'verify.plateNumberPlaceholder' },
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
  ],
  'number-plate': [
    { key: 'plateNumber', labelKey: 'verify.plateNumber', type: 'text', required: true, placeholderKey: 'verify.plateNumberPlaceholder' },
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
  ],
  'birth-certificate': [
    { key: 'lastDigits', labelKey: 'verify.lastDigits', type: 'text', required: true, placeholderKey: 'verify.lastDigitsPlaceholder', sensitive: true, maxLength: 4, helpTextKey: 'verify.lastDigitsHelp' },
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
  ],
  'academic-certificate': [
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
    { key: 'institution', labelKey: 'verify.institution', type: 'text', required: false, placeholderKey: 'verify.institutionPlaceholder' },
    { key: 'lostLocation', labelKey: 'verify.lostLocation', type: 'text', required: false, placeholderKey: 'verify.lostLocationPlaceholder' },
  ],
  'title-deed': [
    { key: 'lastDigits', labelKey: 'verify.lastDigits', type: 'text', required: true, placeholderKey: 'verify.lastDigitsPlaceholder', sensitive: true, maxLength: 4, helpTextKey: 'verify.lastDigitsHelp' },
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
  ],
  'student-id': [
    { key: 'lastDigits', labelKey: 'verify.lastDigits', type: 'text', required: true, placeholderKey: 'verify.lastDigitsPlaceholder', sensitive: true, maxLength: 4, helpTextKey: 'verify.lastDigitsHelp' },
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
    { key: 'lostLocation', labelKey: 'verify.lostLocation', type: 'text', required: false, placeholderKey: 'verify.lostLocationPlaceholder' },
  ],
  'cash-money': [
    { key: 'description', labelKey: 'verify.description', type: 'textarea', required: true, placeholderKey: 'verify.descriptionPlaceholder' },
  ],
  'wallet-with-contents': [
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
    { key: 'brand', labelKey: 'verify.brand', type: 'text', required: false, placeholderKey: 'verify.brandPlaceholder' },
    { key: 'distinctiveMarks', labelKey: 'verify.distinctiveMarks', type: 'textarea', required: false, placeholderKey: 'verify.distinctiveMarksPlaceholder' },
  ],
  'bag-with-documents': [
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
    { key: 'brand', labelKey: 'verify.brand', type: 'text', required: false, placeholderKey: 'verify.brandPlaceholder' },
    { key: 'distinctiveMarks', labelKey: 'verify.distinctiveMarks', type: 'textarea', required: false, placeholderKey: 'verify.distinctiveMarksPlaceholder' },
  ],
  'id-lanyard-badge': [
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
    { key: 'lostLocation', labelKey: 'verify.lostLocation', type: 'text', required: false, placeholderKey: 'verify.lostLocationPlaceholder' },
  ],
  'work-permit-visa': [
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
    { key: 'nationality', labelKey: 'verify.nationality', type: 'text', required: false, placeholderKey: 'verify.nationalityPlaceholder' },
  ],
  'insurance-document': [
    { key: 'lastDigits', labelKey: 'verify.lastDigits', type: 'text', required: true, placeholderKey: 'verify.lastDigitsPlaceholder', sensitive: true, maxLength: 4, helpTextKey: 'verify.lastDigitsHelp' },
    { key: 'fullName', labelKey: 'verify.fullName', type: 'text', required: true, placeholderKey: 'verify.fullNamePlaceholder' },
  ],
    'other-document': [
    { key: 'description', labelKey: 'verify.description', type: 'textarea', required: true, placeholderKey: 'verify.descriptionPlaceholder' },
    { key: 'lostLocation', labelKey: 'verify.lostLocation', type: 'text', required: false, placeholderKey: 'verify.lostLocationPlaceholder' },
  ],
  // ===================
  // ELECTRONICS
  // ===================
  'smartphone': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
    { key: 'distinctiveMarks', labelKey: 'verify.distinctiveMarks', type: 'textarea', required: false, placeholderKey: 'verify.distinctiveMarksPlaceholder' },
  ],
    'feature-phone': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
  ],
  'tablet': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
    { key: 'distinctiveMarks', labelKey: 'verify.distinctiveMarks', type: 'textarea', required: false, placeholderKey: 'verify.distinctiveMarksPlaceholder' },
  ],
  'laptop': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
    { key: 'distinctiveMarks', labelKey: 'verify.distinctiveMarks', type: 'textarea', required: false, placeholderKey: 'verify.distinctiveMarksPlaceholder' },
  ],
  'smartwatch': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
  ],
  'wireless-earphones': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
  ],
  'headphones': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
  ],
  'usb-cable': [
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
  ],
    'phone-charger': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
  ],
  'powerbank': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
  ],
  'flash-drive-hdd': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
    { key: 'color', labelKey: 'verify.color', type: 'text', required: false, placeholderKey: 'verify.colorPlaceholder' },
  ],
  'camera': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
    { key: 'distinctiveMarks', labelKey: 'verify.distinctiveMarks', type: 'textarea', required: false, placeholderKey: 'verify.distinctiveMarksPlaceholder' },
  ],
  'gaming-console': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
  ],
  'memory-card': [
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: true, placeholderKey: 'verify.manufacturerPlaceholder' },
  ],
  // ===================
  // PERSONAL ITEMS
  // ===================
  'empty-wallet': [
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
    { key: 'brand', labelKey: 'verify.brand', type: 'text', required: false, placeholderKey: 'verify.brandPlaceholder' },
    { key: 'distinctiveMarks', labelKey: 'verify.distinctiveMarks', type: 'textarea', required: false, placeholderKey: 'verify.distinctiveMarksPlaceholder' },
  ],
  'bunch-of-keys': [
    { key: 'keyCount', labelKey: 'verify.keyCount', type: 'text', required: true, placeholderKey: 'verify.keyCountPlaceholder' },
    { key: 'distinctiveMarks', labelKey: 'verify.distinctiveMarks', type: 'textarea', required: false, placeholderKey: 'verify.distinctiveMarksPlaceholder' },
  ],
    'single-key': [
    { key: 'distinctiveMarks', labelKey: 'verify.distinctiveMarks', type: 'textarea', required: true, placeholderKey: 'verify.distinctiveMarksPlaceholder' },
  ],
  'padlock': [
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
  ],
  'optical-sunglasses': [
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
  ],
  'umbrella': [
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
  ],
  'jewelry': [
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
    { key: 'distinctiveMarks', labelKey: 'verify.distinctiveMarks', type: 'textarea', required: false, placeholderKey: 'verify.distinctiveMarksPlaceholder' },
  ],
  'bicycle': [
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
    { key: 'manufacturer', labelKey: 'verify.manufacturer', type: 'text', required: false, placeholderKey: 'verify.manufacturerPlaceholder' },
  ],
  'bag-no-docs': [
    { key: 'color', labelKey: 'verify.color', type: 'text', required: true, placeholderKey: 'verify.colorPlaceholder' },
    { key: 'brand', labelKey: 'verify.brand', type: 'text', required: false, placeholderKey: 'verify.brandPlaceholder' },
  ],
  'bible': [
    { key: 'description', labelKey: 'verify.description', type: 'textarea', required: true, placeholderKey: 'verify.descriptionPlaceholder' },
  ],
  'school-book': [
    { key: 'description', labelKey: 'verify.description', type: 'textarea', required: true, placeholderKey: 'verify.descriptionPlaceholder' },
  ],
  'novel': [
    { key: 'description', labelKey: 'verify.description', type: 'textarea', required: true, placeholderKey: 'verify.descriptionPlaceholder' },
  ],
  'notebook-diary': [
    { key: 'description', labelKey: 'verify.description', type: 'textarea', required: true, placeholderKey: 'verify.descriptionPlaceholder' },
  ],
    'other-item': [
    { key: 'description', labelKey: 'verify.description', type: 'textarea', required: true, placeholderKey: 'verify.descriptionPlaceholder' },
    { key: 'color', labelKey: 'verify.color', type: 'text', required: false, placeholderKey: 'verify.colorPlaceholder' },
    { key: 'lostLocation', labelKey: 'verify.lostLocation', type: 'text', required: false, placeholderKey: 'verify.lostLocationPlaceholder' },
  ],
};

/**
 * Returns the verification fields for the given category ID.
 * Falls back to the 'other-item' profile if the category is not explicitly configured.
 *
 * @param categoryId - The category ID from the item's `category_id` field
 * @returns Array of VerificationField objects to render
 */
export function getVerificationFields(categoryId: string): VerificationField[] {
  return verificationProfiles[categoryId] || verificationProfiles['other-item'] || [];
}