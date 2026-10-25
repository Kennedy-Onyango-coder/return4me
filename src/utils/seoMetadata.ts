/**
 * ROUTE-LEVEL SEO METADATA
 * =======================
 * The built `index.html` can only describe the homepage. The server uses these
 * entries to give each public route its own title, description and social image
 * while keeping the planner (`publicRoutes.ts`) focused on indexability.
 *
 * These are static, trusted strings - never request input - so they cannot be
 * used for metadata injection. `applySeoHead()` still escapes them before they
 * are written into the document.
 */
export interface PageMetadata {
  title: string;
  description: string;
  ogImage?: string;
}

const DEFAULT_IMAGE = "https://return4me.co.ke/assets/logo_wordmark_white_bg.jpg";

export const PAGE_METADATA: Record<string, PageMetadata> = {
  '/': {
    title: "Return4me | Kenya's Trusted Lost & Found Platform",
    description: "Return4me is Kenya's secure, trusted lost-and-found platform connecting finders, owners and local agents to return national IDs, driving licenses and vehicle logbooks safely.",
    ogImage: DEFAULT_IMAGE,
  },
  '/lost': {
    title: "Find & Claim Your Lost Item | Return4me",
    description: "Search reported found items on Return4me and start a claim for your lost property through a secure, verified process.",
    ogImage: DEFAULT_IMAGE,
  },
  '/found': {
    title: "Report a Found Item | Return4me",
    description: "Report a found item on Return4me so its owner can be identified and the item returned safely through an approved agent.",
    ogImage: DEFAULT_IMAGE,
  },
  '/report-lost': {
    title: "Report a Lost Item | Return4me",
    description: "Report a lost item on Return4me and let finders and agents help return it to you safely.",
    ogImage: DEFAULT_IMAGE,
  },
  '/become-an-agent': {
    title: "Become an Agent | Return4me",
    description: "Learn how to become a Return4me agent and help return lost property to its owner safely.",
    ogImage: DEFAULT_IMAGE,
  },
  '/sign-in': {
    title: "Sign In | Return4me",
    description: "Sign in to your Return4me account to manage lost reports, claims and returns.",
    ogImage: DEFAULT_IMAGE,
  },
  '/help': {
    title: "Help & FAQ | Return4me",
    description: "Plain answers about how Return4me works: email verification, phone numbers, retrieval fees, collection and escalation.",
    ogImage: DEFAULT_IMAGE,
  },
  '/item': {
    title: "Found Item | Return4me",
    description: "A found item reported on Return4me. Item details are shared only as needed to verify ownership.",
    ogImage: DEFAULT_IMAGE,
  },
  '/account': {
    title: "Account | Return4me",
    description: "Your Return4me account area.",
    ogImage: DEFAULT_IMAGE,
  },
  '/console': {
    title: "Admin Console | Return4me",
    description: "Return4me administration console.",
    ogImage: DEFAULT_IMAGE,
  },
  '/agent_portal': {
    title: "Agent Portal | Return4me",
    description: "Return4me agent workspace.",
    ogImage: DEFAULT_IMAGE,
  },
  '/activate-email': {
    title: "Email Activation | Return4me",
    description: "Activate your Return4me email address.",
    ogImage: DEFAULT_IMAGE,
  },
  '/activate-agent-email': {
    title: "Agent Email Verification | Return4me",
    description: "Verify your Return4me agent email address.",
    ogImage: DEFAULT_IMAGE,
  },
};

/** Metadata for a route, including the dynamic `/item/:id` detail route. */
export function metadataForPath(path: string): PageMetadata | undefined {
  if (path.startsWith('/item/')) return PAGE_METADATA['/item'];
  return PAGE_METADATA[path];
}