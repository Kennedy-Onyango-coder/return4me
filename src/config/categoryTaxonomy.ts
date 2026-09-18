/**
 * CANONICAL CATEGORY TAXONOMY (Phase 9)
 * =====================================
 * Return4me's real, priced categories are the 46 rows seeded by
 * `db.syncDefaultCategories()` in src/db/database.ts. They are administered
 * from the console (create/update/delete, fees, ceiling percentages) and are
 * served to every screen over `GET /api/categories`. That list — not this file —
 * is the source of truth for what can be reported and what it costs.
 *
 * What was actually broken was PRESENTATION. The homepage rendered the
 * categories as one flat run of names joined by "·" inside five ad-hoc groups,
 * and those five groups were typed directly into HomeView.tsx. The result was
 * the reported "wall of categories", and the group membership could silently
 * drift out of step with the database (a category added in the console simply
 * never appeared on the homepage).
 *
 * This module fixes that without inventing anything:
 *   - it references ONLY ids that really exist in the seed (enforced by
 *     src/config/__tests__/categoryTaxonomy.test.ts, which reads the seed
 *     straight out of database.ts);
 *   - every seeded category appears in EXACTLY ONE group (so nothing can be
 *     silently dropped from discovery, and nothing is duplicated);
 *   - the groups are Kenyan-context driven: identity documents, education
 *     records, vehicle/transport records, money and cards, bags, phones and
 *     electronics, keys, eyewear/jewellery, study materials, and a real
 *     "Other" fallback.
 *
 * HARD RULE: this file must never become a second category source. If the
 * console gains a category, `categoryTaxonomy.test.ts` fails until that id is
 * placed in a group here — which is the intended forcing function, because an
 * ungrouped category is invisible to discovery.
 */

export interface CategoryGroupDefinition {
  key: string;
  labelEn: string;
  labelSw: string;
  /** Short, factual one-liner. No counts, no promises, no invented statistics. */
  blurbEn: string;
  blurbSw: string;
  /** Seeded category ids. Order determines display order within the group. */
  ids: readonly string[];
}


export const CATEGORY_TAXONOMY: readonly CategoryGroupDefinition[] = [
  {
    key: 'identity-documents',
    labelEn: 'Identity & Personal Documents',
    labelSw: 'Vitambulisho na Hati za Kibinafsi',
    blurbEn: 'Identity, travel, health-scheme and employment documents.',
    blurbSw: 'Vitambulisho, hati za safari, za bima ya afya na za ajira.',
    ids: [
      'national-id', 'passport', 'birth-certificate', 'work-permit-visa',
      'kra-nhif-nssf', 'insurance-document', 'id-lanyard-badge', 'other-document',
    ],
  },
  {
    key: 'education',
    labelEn: 'Education & Academic Records',
    labelSw: 'Hati za Elimu na Masomo',
    blurbEn: 'School, college and university records and identification.',
    blurbSw: 'Hati za shule, chuo na vyuo vikuu pamoja na vitambulisho.',
    ids: ['academic-certificate', 'student-id'],
  },
  {
    key: 'transport',
    labelEn: 'Driving, Transport & Vehicle Records',
    labelSw: 'Hati za Udereva, Usafiri na Magari',
    blurbEn: 'Licences, logbooks, number plates and property records.',
    blurbSw: 'Leseni, vitabu vya magari, nambari za gari na hati za mali.',
    ids: ['driving-licence', 'vehicle-logbook', 'number-plate', 'title-deed'],
  },
  {
    key: 'money-cards',
    labelEn: 'Money, Cards & Wallets',
    labelSw: 'Pesa, Kadi na Pochi',
    blurbEn: 'Cash, bank and ATM cards, and the wallet or purse holding them.',
    blurbSw: 'Pesa taslimu, kadi za benki na ATM, na pochi zinazozishikilia.',
    ids: ['cash-money', 'atm-credit-card', 'wallet-with-contents', 'empty-wallet'],
  },
  {
    key: 'bags',
    labelEn: 'Bags, Luggage & Carrying',
    labelSw: 'Mikoba, Mizigo na Vifaa vya Kubeba',
    blurbEn: 'Backpacks, handbags, document bags and travel luggage.',
    blurbSw: 'Mikoba ya mgongoni, mikoba ya mkono, mifuko ya hati na mizigo.',
    ids: ['bag-with-documents', 'bag-no-docs'],
  },
  {
    key: 'phones-electronics',
    labelEn: 'Phones, Electronics & Accessories',
    labelSw: 'Simu, Vifaa vya Umeme na Vifaa Vingine',
    blurbEn: 'Phones, computers, storage, audio and charging accessories.',
    blurbSw: 'Simu, kompyuta, hifadhi, sauti na vifaa vya kuchaji.',
    ids: [
      'smartphone', 'feature-phone', 'tablet', 'laptop', 'smartwatch',
      'wireless-earphones', 'headphones', 'camera', 'gaming-console',
      'powerbank', 'phone-charger', 'usb-cable', 'flash-drive-hdd', 'memory-card',
    ],
  },
  {
    key: 'keys-access',
    labelEn: 'Keys & Access',
    labelSw: 'Funguo na Ufikiaji',
    blurbEn: 'House, office and vehicle keys, and padlocks.',
    blurbSw: 'Funguo za nyumbani, ofisini na za gari, pamoja na kufuli.',
    ids: ['bunch-of-keys', 'single-key', 'padlock'],
  },
  {
    key: 'jewellery-eyewear',
    labelEn: 'Jewellery, Watches & Eyewear',
    labelSw: 'Vito, Saa na Miwani',
    blurbEn: 'Jewellery, watches, sunglasses and prescription eyewear.',
    blurbSw: 'Vito, saa, miwani ya jua na miwani ya macho.',
    ids: ['jewelry', 'optical-sunglasses'],
  },
  {
    key: 'books-study',
    labelEn: 'Books & Study Materials',
    labelSw: 'Vitabu na Vifaa vya Kujifunzia',
    blurbEn: 'Textbooks, reference books, bibles and notebooks.',
    blurbSw: 'Vitabu vya masomo, vitabu vya marejeleo, Biblia na madaftari.',
    ids: ['school-book', 'bible', 'novel', 'notebook-diary'],
  },
  {
    key: 'other',
    labelEn: 'Other Items',
    labelSw: 'Vitu Vingine',
    blurbEn: 'Anything not covered above — including umbrellas and bicycles.',
    blurbSw: 'Kitu chochote kisichoainishwa juu — pamoja na mwavuli na baiskeli.',
    ids: ['other-item', 'umbrella', 'bicycle'],
  },
] as const;

/** Every seeded category id that the taxonomy places in a group. */
export function groupedCategoryIds(): string[] {
  return CATEGORY_TAXONOMY.flatMap((group) => [...group.ids]);
}

/**
 * Resolves the taxonomy groups against live categories from `/api/categories`.
 * A group whose ids are ALL absent from the live list is dropped (the console
 * has not enabled those categories), so the UI never advertises a category the
 * backend cannot actually accept.
 */
export function resolveTaxonomy<T extends { id?: string }>(
  categories: T[] | null | undefined
): Array<CategoryGroupDefinition & { categories: T[] }> {
  const byId = new Map<string, T>();
  for (const category of categories || []) {
    if (category && typeof category.id === 'string') byId.set(category.id, category);
  }

  const resolved = CATEGORY_TAXONOMY.map((group) => ({
    ...group,
    categories: group.ids
      .map((id) => byId.get(id))
      .filter((c): c is T => Boolean(c)),
  }));

  // P14A (P14-02) — UNGROUPED LIVE CATEGORIES MUST STILL BE DISCOVERABLE.
  // An administrator can create a brand-new category in the console at any
  // time; its id is by definition not in the hand-maintained `ids` lists
  // above. That category IS reportable and priced by the backend, so dropping
  // it here would hide a real category from the homepage's only discovery
  // surface. It is attached to the single existing fallback group ("Other")
  // rather than dropped or listed a second time here — no new group, no new
  // category source, and the grouped ids keep their existing groups.
  const groupedIds = new Set(groupedCategoryIds());
  const ungrouped: T[] = [];
  for (const [id, category] of byId) {
    if (!groupedIds.has(id)) ungrouped.push(category);
  }
  if (ungrouped.length > 0) {
    const fallback = resolved.find((group) => group.key === FALLBACK_GROUP_KEY);
    // The fallback group always exists in CATEGORY_TAXONOMY (a test enforces
    // exactly one); `find` rather than an index so the group is inserted in
    // its declared position if it had no live members of its own.
    if (fallback) fallback.categories.push(...ungrouped);
  }

  return resolved.filter((group) => group.categories.length > 0);
}

/**
 * The fallback group. `CATEGORY_TAXONOMY` must contain exactly one group
 * carrying this key, and it must contain the seeded 'other-item' category — a
 * person whose item fits nowhere must still be able to report it.
 */
export const FALLBACK_GROUP_KEY = 'other';
