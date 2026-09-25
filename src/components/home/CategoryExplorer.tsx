import React, { useMemo, useState } from 'react';
import {
  ShieldCheck, GraduationCap, Car, CreditCard, Briefcase, Smartphone,
  Key, Gem, BookOpen, Package, Search, ChevronDown, MapPin,
} from 'lucide-react';
import { resolveTaxonomy } from '../../config/categoryTaxonomy';
import Button from '../ui/Button';

/**
 * CATEGORY EXPLORER (Phase 9 — Request 06)
 * =======================================
 * Replaces the old "Common items people lose" section, which rendered every
 * category name in the database as one run of text joined by "·" — the
 * reported "giant unreadable wall of categories".
 *
 * Everything shown here is REAL: the groups come from src/config/categoryTaxonomy
 * (which a test proves is anchored to the categories the backend actually
 * seeds), and the chips are the live categories returned by GET /api/categories.
 * A group with no live categories is not rendered at all, so this screen can
 * never advertise something the backend cannot accept.
 *
 * Interaction, deliberately simple enough to work on a mid-range Android phone:
 *   - a search box that filters the LIVE category names in both languages;
 *   - the first few groups shown by default, the rest behind one "show all"
 *     disclosure (the alternative was a wall of >40 items, which is the defect);
 *   - each chip is a plain, non-interactive label: there is no per-category URL
 *     or deep link in this phase, so nothing here pretends to be a link.
 */
interface CategoryExplorerProps {
  categories: any[];
  lang: 'en' | 'sw';
  onReportLost: () => void;
  onReportFound: () => void;
}

const GROUP_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>> = {
  'identity-documents': ShieldCheck,
  education: GraduationCap,
  transport: Car,
  'money-cards': CreditCard,
  bags: Briefcase,
  'phones-electronics': Smartphone,
  'keys-access': Key,
  'jewellery-eyewear': Gem,
  'books-study': BookOpen,
  other: Package,
};

/** Groups rendered before the "show all" disclosure is needed. */
const DEFAULT_VISIBLE_GROUPS = 4;

export default function CategoryExplorer({ categories, lang, onReportLost, onReportFound }: CategoryExplorerProps) {
  const en = lang === 'en';
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);

  const groups = useMemo(() => {
    const resolved = resolveTaxonomy(categories);
    const needle = query.trim().toLowerCase();
    if (!needle) return resolved;
    return resolved
      .map((group) => ({
        ...group,
        categories: group.categories.filter((category: any) => {
          const name = (en ? category?.name_en : category?.name_sw) || category?.name_en || '';
          return String(name).toLowerCase().includes(needle);
        }),
      }))
      .filter((group) => group.categories.length > 0);
  }, [categories, query, en]);

  const isSearching = query.trim().length > 0;
  const visibleGroups = isSearching || showAll ? groups : groups.slice(0, DEFAULT_VISIBLE_GROUPS);
  const hiddenGroupCount = groups.length - visibleGroups.length;
  const totalCategories = groups.reduce((sum, group) => sum + group.categories.length, 0);
  const categoryName = (category: any) =>
    String((en ? category?.name_en : category?.name_sw) || category?.name_en || '');

  if (groups.length === 0 && !isSearching) return null;

  return (
    <div className="mt-8">
      {/* Search over the REAL category names (both languages). */}
      <div className="max-w-md">
        <label htmlFor="category-explorer-search" className="block text-caption font-bold uppercase tracking-wider text-ink-muted">
          {en ? 'Search categories' : 'Tafuta kategoria'}
        </label>
        <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-line-subtle bg-white px-3 focus-within:border-primary-green">
          <Search size={16} className="text-ink-muted shrink-0" aria-hidden={true} />
          <input
            id="category-explorer-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={en ? 'e.g. passport, phone, keys' : 'Mfano: pasipoti, simu, funguo'}
            aria-describedby="category-explorer-summary"
            className="w-full border-0 bg-transparent py-2.5 text-sm text-ink outline-none"
          />
        </div>
      </div>

      {/* Live region: the result count is announced as the query changes.
          PHASE 16.1 BATCH 1C — when the disclosure is hiding groups, the summary
          now says so, so the announced totals and the rendered content agree (it
          previously announced all groups while only the first four were in the
          DOM). The clause is added ONLY when something is actually hidden, and it
          names the button by its own label ("Show all …" / "Onyesha makundi
          yote …") so the instruction points at the real control. */}
      <p id="category-explorer-summary" aria-live="polite" className="mt-3 text-small text-ink-muted">
        {isSearching
          ? (en
            ? `${totalCategories} matching ${totalCategories === 1 ? 'category' : 'categories'} in ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}.`
            : `Kategoria ${totalCategories} zinazolingana katika makundi ${groups.length}.`)
          : (en
            ? `${totalCategories} item types across ${groups.length} groups.${hiddenGroupCount > 0 ? ` ${visibleGroups.length} of ${groups.length} groups shown — use Show all to see the rest.` : ''}`
            : `Aina ${totalCategories} za vitu katika makundi ${groups.length}.${hiddenGroupCount > 0 ? ` Makundi ${visibleGroups.length} kati ya ${groups.length} yameonyeshwa — tumia Onyesha makundi yote kuona mengine.` : ''}`)}
      </p>

      {/* PHASE 16.1 BATCH 1C — the region the "Show all" disclosure controls.
          It carries a stable id (same `category-explorer-*` convention as the
          search input and the live region) so the button's `aria-controls`
          resolves to a real element. Hidden groups remain OMITTED from the DOM —
          no CSS-only hiding and no aria-hidden — so this id always points at the
          list that is actually rendered. */}
      {groups.length === 0 ? (
        <div className="mt-6 rounded-xl border border-line-subtle bg-white p-6 text-center">
          <p className="text-sm text-ink-muted">
            {en ? 'No category matches that search.' : 'Hakuna kategoria inayolingana na utafutaji huo.'}
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setQuery('')}>
            {en ? 'Clear search' : 'Futa utafutaji'}
          </Button>
        </div>
      ) : (
        <ul id="category-explorer-groups" className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {visibleGroups.map((group) => {
            const Icon = GROUP_ICONS[group.key] ?? Package;
            return (
              <li key={group.key} className="border border-line-subtle rounded-xl bg-white p-5">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-green/10">
                    <Icon size={18} className="text-primary-green" aria-hidden={true} />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-ink">{en ? group.labelEn : group.labelSw}</h3>
                    <p className="mt-1 text-caption text-ink-muted leading-relaxed">
                      {en ? group.blurbEn : group.blurbSw}
                    </p>
                  </div>
                </div>
                <ul className="mt-4 flex flex-wrap gap-1.5">
                  {group.categories.map((category: any) => (
                    <li
                      key={category.id}
                      className="rounded-full border border-line-subtle bg-canvas-muted px-2.5 py-1 text-caption font-semibold text-ink"
                    >
                      {categoryName(category)}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}

      {hiddenGroupCount > 0 && (
        <div className="mt-5">
          {/* PHASE 16.1 BATCH 1C — the disclosure's state is now announced.
              `aria-expanded` reflects `showAll` and `aria-controls` points at the
              group list above, so a screen-reader user learns both that more
              groups exist and whether they have been revealed. No focus
              management is added: activating this simply renders the remaining
              groups, which is the existing behaviour. */}
          <Button
            variant="outline"
            size="md"
            onClick={() => setShowAll(true)}
            aria-expanded={showAll}
            aria-controls="category-explorer-groups"
          >
            {en ? `Show all ${groups.length} groups` : `Onyesha makundi yote ${groups.length}`}
            <ChevronDown size={16} aria-hidden={true} />
          </Button>
        </div>
      )}

      {/* Two honest calls to action — each one reports an item, which is the
          only capability the backend actually implements today. */}
      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Button variant="primary" size="lg" onClick={onReportLost}>
          {en ? 'I lost something' : 'Nimepoteza kitu'}
        </Button>
        <Button variant="outline" size="lg" onClick={onReportFound}>
          <MapPin size={18} aria-hidden={true} />
          {en ? 'I found something' : 'Nimepata kitu'}
        </Button>
      </div>
    </div>
  );
}
