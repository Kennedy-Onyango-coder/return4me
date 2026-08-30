import React, { useState, useEffect, useRef } from 'react';
import { translations } from '../types';
import { ShieldCheck, BarChart2, Users, FileCheck, Coins, HelpCircle, Loader2, ArrowRight, AlertCircle, AlertTriangle, RefreshCw, CheckCircle, ShieldAlert, Package } from 'lucide-react';

interface AdminViewProps {
  lang: 'en' | 'sw';
  token: string | null;
  setToken: (token: string | null) => void;
}

export default function AdminView({ lang, token, setToken }: AdminViewProps) {
  const t = translations[lang];

  // Passcode verification states
  const [username, setUsername] = useState('');
  const [passcode, setPasscode] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Dashboard Stats & Lists states
  const [activeTab, setActiveTab] = useState<'stats' | 'agents' | 'disputes' | 'ledger' | 'review' | 'categories' | 'strikes' | 'found_items'>('stats');
  const [dashboardData, setDashboardData] = useState<any | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dataError, setDataError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [actionWarning, setActionWarning] = useState('');

  // Emergency pause controls: reports/claims/payments/payouts/handovers,
  // alongside the pre-existing social-publishing pause above. Fetched
  // separately from dashboardData since it's its own small, fast,
  // admin-only endpoint (GET /api/admin/settings/pause-status) rather than
  // folded into the heavier dashboard payload.
  const [pauseStatuses, setPauseStatuses] = useState<Record<string, boolean> | null>(null);

  // Admin 2FA enrollment (Security section, stats tab)
  const [twoFaSetupData, setTwoFaSetupData] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [twoFaConfirmCode, setTwoFaConfirmCode] = useState('');
  const [twoFaDisablePassword, setTwoFaDisablePassword] = useState('');
  const [twoFaShowDisableForm, setTwoFaShowDisableForm] = useState(false);
  const [twoFaProcessing, setTwoFaProcessing] = useState(false);
  const [twoFaMessage, setTwoFaMessage] = useState('');
  const [twoFaError, setTwoFaError] = useState('');
  const [adminTotpEnabled, setAdminTotpEnabled] = useState(false);
  const [paymentStrikes, setPaymentStrikes] = useState<any[]>([]);
  const [paymentStrikesLoading, setPaymentStrikesLoading] = useState(false);

  // New States for Agents Directory & Found Items Tabs
  const [agentSearch, setAgentSearch] = useState('');
  const [agentStatusFilter, setAgentStatusFilter] = useState('all');
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

  const [itemSearch, setItemSearch] = useState('');
  const [itemStatusFilter, setItemStatusFilter] = useState('all');
  const [itemCategoryFilter, setItemCategoryFilter] = useState('all');
  const [itemFlagFilter, setItemFlagFilter] = useState('all');
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const lightboxCloseRef = useRef<HTMLDivElement | null>(null);

  // The lightbox previously only closed via a mouse click on the backdrop —
  // no Escape key, and nothing to receive that keypress anyway since focus
  // never moved into the dialog when it opened. Moving focus onto the
  // backdrop here means Escape (wired via onKeyDown on that div above)
  // actually reaches a listener, and a keyboard-only admin isn't stuck
  // once they've opened a full-size photo.
  useEffect(() => {
    if (lightboxImage && lightboxCloseRef.current) {
      lightboxCloseRef.current.focus();
    }
  }, [lightboxImage]);


  // Categories loading for admin corrections
  const [categories, setCategories] = useState<any[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState<boolean>(true);

  // Admin Categories List & Form states
  const [adminCategories, setAdminCategories] = useState<any[]>([]);
  const [adminCategoriesLoading, setAdminCategoriesLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<any | null>(null);
  const [showCategoryForm, setShowCategoryForm] = useState<'create' | 'edit' | null>(null);

  const [catFormId, setCatFormId] = useState('');
  const [catFormNameEn, setCatFormNameEn] = useState('');
  const [catFormNameSw, setCatFormNameSw] = useState('');
  const [catFormTotalFee, setCatFormTotalFee] = useState(0);
  const [catFormFinderShare, setCatFormFinderShare] = useState(0);
  const [catFormAgentShare, setCatFormAgentShare] = useState(0);
  const [catFormPlatformShare, setCatFormPlatformShare] = useState(0);
  const [catFormIsSensitive, setCatFormIsSensitive] = useState(true);
  const [catSaving, setCatSaving] = useState(false);
  // Recovery Fee Engine config (src/services/feeEngine.ts) — ignored by the
  // engine when is_admin_modified is true, in which case the flat total_fee/
  // finder_share/agent_share/platform_share above are used verbatim instead.
  const [catFormBaseFee, setCatFormBaseFee] = useState(0);
  const [catFormComplexityFee, setCatFormComplexityFee] = useState(0);
  const [catFormDelayFee, setCatFormDelayFee] = useState(0);
  const [catFormCeilingPercent, setCatFormCeilingPercent] = useState(12);
  const [catFormFinderPct, setCatFormFinderPct] = useState(25);
  const [catFormAgentPct, setCatFormAgentPct] = useState(35);
  const [catFormPlatformPct, setCatFormPlatformPct] = useState(40);
  const [catFormFinderRewardCap, setCatFormFinderRewardCap] = useState<string>('');
  const [catFormElevatedReview, setCatFormElevatedReview] = useState(false);
  const [catFormIsAdminModified, setCatFormIsAdminModified] = useState(false);

  const resetCategoryForm = (mode: 'create' | 'edit', cat?: any) => {
    setShowCategoryForm(mode);
    if (mode === 'create') {
      setCatFormId('');
      setCatFormNameEn('');
      setCatFormNameSw('');
      setCatFormTotalFee(0);
      setCatFormFinderShare(0);
      setCatFormAgentShare(0);
      setCatFormPlatformShare(0);
      setCatFormIsSensitive(true);
      setCatFormBaseFee(0);
      setCatFormComplexityFee(0);
      setCatFormDelayFee(0);
      setCatFormCeilingPercent(12);
      setCatFormFinderPct(25);
      setCatFormAgentPct(35);
      setCatFormPlatformPct(40);
      setCatFormFinderRewardCap('');
      setCatFormElevatedReview(false);
      setCatFormIsAdminModified(false);
      setSelectedCategory(null);
    } else if (mode === 'edit' && cat) {
      setCatFormId(cat.id);
      setCatFormNameEn(cat.name_en);
      setCatFormNameSw(cat.name_sw);
      setCatFormTotalFee(typeof cat.total_fee === 'string' ? parseFloat(cat.total_fee) : cat.total_fee);
      setCatFormFinderShare(typeof cat.finder_share === 'string' ? parseFloat(cat.finder_share) : cat.finder_share);
      setCatFormAgentShare(typeof cat.agent_share === 'string' ? parseFloat(cat.agent_share) : cat.agent_share);
      setCatFormPlatformShare(typeof cat.platform_share === 'string' ? parseFloat(cat.platform_share) : cat.platform_share);
      setCatFormIsSensitive(cat.is_sensitive_document || false);
      setCatFormBaseFee(cat.base_fee !== undefined && cat.base_fee !== null ? Number(cat.base_fee) : 0);
      setCatFormComplexityFee(cat.complexity_fee !== undefined && cat.complexity_fee !== null ? Number(cat.complexity_fee) : 0);
      setCatFormDelayFee(cat.delay_fee !== undefined && cat.delay_fee !== null ? Number(cat.delay_fee) : 0);
      setCatFormCeilingPercent(cat.ceiling_percent !== undefined && cat.ceiling_percent !== null ? Number(cat.ceiling_percent) : 12);
      setCatFormFinderPct(cat.finder_pct !== undefined && cat.finder_pct !== null ? Number(cat.finder_pct) : 25);
      setCatFormAgentPct(cat.agent_pct !== undefined && cat.agent_pct !== null ? Number(cat.agent_pct) : 35);
      setCatFormPlatformPct(cat.platform_pct !== undefined && cat.platform_pct !== null ? Number(cat.platform_pct) : 40);
      setCatFormFinderRewardCap(cat.finder_reward_cap !== undefined && cat.finder_reward_cap !== null ? String(cat.finder_reward_cap) : '');
      setCatFormElevatedReview(cat.elevated_review || false);
      setCatFormIsAdminModified(cat.is_admin_modified || false);
      setSelectedCategory(cat);
    }
  };

  // Manual Review Form states
  const [selectedReviewItem, setSelectedReviewItem] = useState<any | null>(null);
  const [reviewCategoryId, setReviewCategoryId] = useState('national-id');
  const [reviewOcrNumber, setReviewOcrNumber] = useState('');
  const [reviewOcrName, setReviewOcrName] = useState('');
  const [reviewIsDescriptionOnly, setReviewIsDescriptionOnly] = useState(false);
  const [reviewDescription, setReviewDescription] = useState('');
  const [reviewAssignedAgentId, setReviewAssignedAgentId] = useState('');
  const [reviewSaving, setReviewSaving] = useState(false);
  const [adminActionProcessing, setAdminActionProcessing] = useState(false);

  // Confirmation Modal State
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const startReview = (item: any) => {
    setSelectedReviewItem(item);
    setReviewCategoryId(item.category_id || 'national-id');
    setReviewOcrNumber(item.ocr_extracted_number || '');
    setReviewOcrName(item.ocr_extracted_name || '');
    setReviewIsDescriptionOnly(item.isDescriptionOnly || false);
    setReviewDescription(item.description || '');
    setReviewAssignedAgentId(item.assigned_agent_id || '');
  };

  const handleSaveReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedReviewItem) return;
    setReviewSaving(true);
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    try {
      const response = await fetch(`/api/admin/items/${selectedReviewItem.id}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          categoryId: reviewCategoryId,
          ocrExtractedNumber: reviewIsDescriptionOnly ? null : reviewOcrNumber,
          ocrExtractedName: reviewIsDescriptionOnly ? null : reviewOcrName,
          isDescriptionOnly: reviewIsDescriptionOnly,
          description: reviewDescription,
          assignedAgentId: reviewAssignedAgentId || undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Review save failed');
      }

      setActionSuccess('Item manual review saved successfully and is now searchable.');
      setSelectedReviewItem(null);
      fetchDashboardData();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setReviewSaving(false);
    }
  };

  const fetchDashboardData = async () => {
    if (!token) return;
    setDataError('');
    setDashboardLoading(true);
    try {
      const response = await fetch('/api/admin/dashboard', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 401 || response.status === 403) {
        setToken(null);
        setAuthError(lang === 'en' 
          ? 'Your administrator session has expired or is invalid. Please log in again.' 
          : 'Muda wako wa kuingia kama msimamizi umeisha au si sahihi. Tafadhali ingia tena.'
        );
        return;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error(lang === 'en'
          ? 'The system returned an invalid response. Please try again shortly.'
          : 'Mfumo ulirudisha jibu lisilo sahihi. Tafadhali jaribu tena baada ya muda mfupi.'
        );
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch admin statistics.');
      }
      setDashboardData(data);
      setAdminTotpEnabled(!!data.currentAdminTotpEnabled);
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setDashboardLoading(false);
    }
  };

  const fetchPauseStatuses = async () => {
    if (!token) return;
    try {
      const response = await fetch('/api/admin/settings/pause-status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (response.ok && data.statuses) {
        setPauseStatuses(data.statuses);
      }
    } catch {
      // Non-critical — the dedicated pause toggle buttons below re-fetch
      // this after every successful toggle, and the social-publishing
      // toggle (which already has its own state in dashboardData) is
      // unaffected by this call failing.
    }
  };

  const handleTogglePause = async (scope: string, paused: boolean) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setItemActionProcessing('pause:' + scope);
    try {
      const response = await fetch('/api/admin/settings/pause', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ scope, paused }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Failed to update ${scope} pause setting`);
      }
      setActionSuccess(data.message || 'Setting updated.');
      fetchPauseStatuses();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setItemActionProcessing(null);
    }
  };

  const fetchAdminCategories = async () => {
    if (!token) return;
    setAdminCategoriesLoading(true);
    try {
      const response = await fetch('/api/admin/categories', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 401 || response.status === 403) {
        setToken(null);
        setAuthError(lang === 'en' 
          ? 'Your administrator session has expired or is invalid. Please log in again.' 
          : 'Muda wako wa kuingia kama msimamizi umeisha au si sahihi. Tafadhali ingia tena.'
        );
        return;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error(lang === 'en'
          ? 'The system returned an invalid response. Please try again shortly.'
          : 'Mfumo ulirudisha jibu lisilo sahihi. Tafadhali jaribu tena baada ya muda mfupi.'
        );
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch admin categories.');
      }
      setAdminCategories(data);
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setAdminCategoriesLoading(false);
    }
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    // ID validation for create mode
    if (showCategoryForm === 'create') {
      if (!catFormId || !/^[a-z0-9-]+$/.test(catFormId)) {
        setDataError('ID must be lowercase-kebab-case (e.g., national-id) and cannot be empty.');
        return;
      }
    }

    if (!catFormNameEn.trim() || !catFormNameSw.trim()) {
      setDataError('Both English and Swahili names are required.');
      return;
    }

    const total = parseFloat(Number(catFormTotalFee).toFixed(2));
    const sharesSum = parseFloat((Number(catFormFinderShare) + Number(catFormAgentShare) + Number(catFormPlatformShare)).toFixed(2));

    if (total !== sharesSum) {
      setDataError(`Validation Error: The shares (Finder: KES ${catFormFinderShare} + Agent: KES ${catFormAgentShare} + Platform: KES ${catFormPlatformShare} = KES ${sharesSum}) must exactly equal the Total Fee: KES ${catFormTotalFee}.`);
      return;
    }

    setCatSaving(true);
    try {
      const url = showCategoryForm === 'create'
        ? '/api/admin/categories'
        : `/api/admin/categories/${catFormId}`;
      const method = showCategoryForm === 'create' ? 'POST' : 'PUT';

      const bodyData = {
        id: catFormId,
        name_en: catFormNameEn,
        name_sw: catFormNameSw,
        total_fee: catFormTotalFee,
        finder_share: catFormFinderShare,
        agent_share: catFormAgentShare,
        platform_share: catFormPlatformShare,
        is_sensitive_document: catFormIsSensitive,
        base_fee: catFormBaseFee,
        complexity_fee: catFormComplexityFee,
        delay_fee: catFormDelayFee,
        ceiling_percent: catFormCeilingPercent,
        finder_pct: catFormFinderPct,
        agent_pct: catFormAgentPct,
        platform_pct: catFormPlatformPct,
        finder_reward_cap: catFormFinderRewardCap.trim() === '' ? null : parseFloat(catFormFinderRewardCap),
        elevated_review: catFormElevatedReview,
        is_admin_modified: catFormIsAdminModified,
      };

      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(bodyData),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save category');
      }

      setActionSuccess(showCategoryForm === 'create'
        ? 'Category created successfully!'
        : 'Category updated successfully!'
      );
      setShowCategoryForm(null);
      fetchAdminCategories();
      // Also sync user categories lists
      const catRes = await fetch('/api/categories');
      const catData = await catRes.json();
      setCategories(catData);
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setCatSaving(false);
    }
  };

  const handleDeleteCategory = (id: string, nameEn: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    setConfirmModal({
      title: lang === 'en' ? 'Delete Category' : 'Futa Kitengo',
      message: lang === 'en' 
        ? `Are you sure you want to delete the category "${nameEn}"? This action cannot be undone.` 
        : `Je, una uhakika unataka kufuta kitengo cha "${nameEn}"? Kitendo hiki hakiwezi kubatilishwa.`,
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/admin/categories/${id}`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });

          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || 'Failed to delete category.');
          }

          setActionSuccess('Category deleted successfully!');
          fetchAdminCategories();
          // Also sync user categories lists
          const catRes = await fetch('/api/categories');
          const catData = await catRes.json();
          setCategories(catData);
        } catch (e: any) {
          setDataError(e.message);
        }
      }
    });
  };

  useEffect(() => {
    if (token) {
      fetchDashboardData();
      fetchAdminCategories();
      fetchPauseStatuses();
    }
  }, [token]);

  useEffect(() => {
    if (activeTab === 'categories' && token) {
      fetchAdminCategories();
    }
  }, [activeTab]);

  useEffect(() => {
    const fetchCategories = async () => {
      try {
        setCategoriesLoading(true);
        const res = await fetch('/api/categories');
        const data = await res.json();
        setCategories(data);
      } catch (e) {
        console.error("Failed to fetch categories in AdminView:", e);
      } finally {
        setCategoriesLoading(false);
      }
    };
    fetchCategories();
  }, []);

  const fetchPaymentStrikes = async () => {
    if (!token) return;
    setPaymentStrikesLoading(true);
    setDataError('');
    try {
      const response = await fetch('/api/admin/payment-strikes', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 401 || response.status === 403) {
        setToken(null);
        setAuthError(lang === 'en' 
          ? 'Your administrator session has expired or is invalid. Please log in again.' 
          : 'Muda wako wa kuingia kama msimamizi umeisha au si sahihi. Tafadhali ingia tena.'
        );
        return;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error(lang === 'en'
          ? 'The system returned an invalid response. Please try again shortly.'
          : 'Mfumo ulirudisha jibu lisilo sahihi. Tafadhali jaribu tena baada ya muda mfupi.'
        );
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch payment strikes.');
      }
      setPaymentStrikes(data.strikes || []);
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setPaymentStrikesLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'strikes' && token) {
      fetchPaymentStrikes();
    }
  }, [activeTab, token]);

  const handleClearStrikes = (phone: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    setConfirmModal({
      title: lang === 'en' ? 'Clear Payment Strikes' : 'Ondoa Vikwazo vya Malipo',
      message: lang === 'en'
        ? `Are you sure you want to clear all payment strikes for ${phone}?`
        : `Je, una uhakika unataka kuondoa vikwazo vyote vya malipo vya ${phone}?`,
      onConfirm: async () => {
        setAdminActionProcessing(true);
        try {
          const response = await fetch(`/api/admin/payment-strikes/${phone}/clear`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Failed to clear strikes');
          }
          setActionSuccess(data.message || `Cleared payment strikes for ${phone}`);
          fetchPaymentStrikes(); // Reload list
        } catch (e: any) {
          setDataError(e.message);
        } finally {
          setAdminActionProcessing(false);
        }
      }
    });
  };

  // Admin authenticate
  const [pendingTwoFactorToken, setPendingTwoFactorToken] = useState<string | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorLoading, setTwoFactorLoading] = useState(false);

  const handleAdminAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);

    try {
      const response = await fetch('/api/auth/admin-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, passcode }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Incorrect password');
      }

      // Password verified, but this account has 2FA enrolled — the server
      // deliberately withheld the real session token and issued a
      // short-lived pending one instead. Show the code-entry step rather
      // than logging in.
      if (data.requiresTwoFactor) {
        setPendingTwoFactorToken(data.pendingToken);
        return;
      }

      setToken(data.token);
      setAdminTotpEnabled(!!data.profile?.totpEnabled);
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleTwoFactorVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setTwoFactorLoading(true);

    try {
      const response = await fetch('/api/auth/admin-login/verify-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken: pendingTwoFactorToken, code: twoFactorCode }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Incorrect 2FA code');
      }

      setToken(data.token);
      setAdminTotpEnabled(!!data.profile?.totpEnabled);
      setPendingTwoFactorToken(null);
      setTwoFactorCode('');
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setTwoFactorLoading(false);
    }
  };

  // Begin 2FA enrollment: fetch a fresh secret/QR from the server. Nothing
  // is enabled yet — that only happens once handleTwoFaConfirm below
  // succeeds with a real code from the admin's authenticator app.
  const handleTwoFaStartSetup = async () => {
    setTwoFaError('');
    setTwoFaMessage('');
    setTwoFaProcessing(true);
    try {
      const response = await fetch('/api/auth/admin-2fa/setup', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to start 2FA setup');
      setTwoFaSetupData({ secret: data.secret, otpauthUrl: data.otpauthUrl });
    } catch (e: any) {
      setTwoFaError(e.message);
    } finally {
      setTwoFaProcessing(false);
    }
  };

  const handleTwoFaConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setTwoFaError('');
    setTwoFaMessage('');
    setTwoFaProcessing(true);
    try {
      const response = await fetch('/api/auth/admin-2fa/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: twoFaConfirmCode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Incorrect code');
      setTwoFaMessage(data.message);
      setTwoFaSetupData(null);
      setTwoFaConfirmCode('');
      setAdminTotpEnabled(true);
    } catch (e: any) {
      setTwoFaError(e.message);
    } finally {
      setTwoFaProcessing(false);
    }
  };

  const handleTwoFaDisable = async (e: React.FormEvent) => {
    e.preventDefault();
    setTwoFaError('');
    setTwoFaMessage('');
    setTwoFaProcessing(true);
    try {
      const response = await fetch('/api/auth/admin-2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: twoFaDisablePassword }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Incorrect password');
      setTwoFaMessage(data.message);
      setTwoFaShowDisableForm(false);
      setTwoFaDisablePassword('');
      setAdminTotpEnabled(false);
    } catch (e: any) {
      setTwoFaError(e.message);
    } finally {
      setTwoFaProcessing(false);
    }
  };

  // Approve Agent
  const [locationFormAgentId, setLocationFormAgentId] = useState<string | null>(null);
  const [locationFormLat, setLocationFormLat] = useState('');
  const [locationFormLon, setLocationFormLon] = useState('');

  const handleSetAgentLocation = async (id: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    if (!locationFormLat || !locationFormLon) {
      setDataError(lang === 'en' ? 'Enter both latitude and longitude.' : 'Weka latitude na longitude.');
      return;
    }
    setAdminActionProcessing(true);
    try {
      const response = await fetch(`/api/admin/agents/${id}/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ latitude: locationFormLat, longitude: locationFormLon }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update agent location');
      }
      setActionSuccess(data.message);
      setLocationFormAgentId(null);
      setLocationFormLat('');
      setLocationFormLon('');
      fetchDashboardData(); // Reload
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setAdminActionProcessing(false);
    }
  };

  const handleApproveAgent = (id: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    setConfirmModal({
      title: lang === 'en' ? 'Approve Agent' : 'Muidhinishe Wakala',
      message: lang === 'en'
        ? "Are you sure you want to approve this agent? They will gain access to handle sensitive documents and receive payouts."
        : "Je, una uhakika unataka kumuidhinisha wakala huyu? Atapata uwezo wa kushughulikia nyaraka nyeti na kupokea malipo.",
      onConfirm: async () => {
        setAdminActionProcessing(true);
        try {
          const response = await fetch(`/api/admin/agents/${id}/approve`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Failed to approve agent');
          }
          setActionSuccess(data.message);
          fetchDashboardData(); // Reload
        } catch (e: any) {
          setDataError(e.message);
        } finally {
          setAdminActionProcessing(false);
        }
      }
    });
  };

  // Suspend Agent
  const handleSuspendAgent = (id: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    setConfirmModal({
      title: lang === 'en' ? 'Suspend Agent' : 'Msimamishe Wakala',
      message: lang === 'en'
        ? "Are you sure you want to suspend this agent? They will no longer be able to accept drop-offs or process handovers."
        : "Je, una uhakika unataka kumsimamisha wakala huyu? Hataweza tena kupokea bidhaa au kushughulikia makabidhiano.",
      onConfirm: async () => {
        setAdminActionProcessing(true);
        try {
          const response = await fetch(`/api/admin/agents/${id}/suspend`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Failed to suspend agent');
          }
          setActionSuccess(data.message);
          fetchDashboardData(); // Reload
        } catch (e: any) {
          setDataError(e.message);
        } finally {
          setAdminActionProcessing(false);
        }
      }
    });
  };

  // Issue Official Warning to Agent
  const handleWarnAgent = (id: string) => {
    const reason = prompt(lang === 'en' ? 'Enter reason for issuing warning to this agent:' : 'Weka sababu ya kumpa wakala huyu onyo:');
    if (!reason || reason.trim() === '') return;

    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setAdminActionProcessing(true);

    fetch(`/api/admin/agents/${id}/warn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ reason }),
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to warn agent');
        setActionSuccess(data.message);
        fetchDashboardData();
      })
      .catch(err => setDataError(err.message))
      .finally(() => setAdminActionProcessing(false));
  };

  // Resolve Dispute
  const handleResolveDispute = (disputeId: string, winningClaimId: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    setConfirmModal({
      title: lang === 'en' ? 'Resolve Dispute' : 'Suluhisha Mzozo',
      message: lang === 'en'
        ? "Are you sure you want to resolve this dispute in favor of this claimant? Escrow funds will be released and this cannot be undone."
        : "Je, una uhakika unataka kusuluhisha mzozo huu kwa kumpendelea mdai huyu? Fedha za amana zitatolewa na kitendo hiki hakiwezi kubatilishwa.",
      onConfirm: async () => {
        setAdminActionProcessing(true);
        try {
          const response = await fetch('/api/admin/disputes/resolve', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              disputeId,
              winningClaimId,
              adminNotes: 'Resolved physically by administrator reviewing official government-issued ID proofs.',
            }),
          });

          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Dispute resolution failed');
          }

          // A refund-transfer failure is reported with success:true (the
          // dispute itself WAS resolved — that decision doesn't get rolled
          // back) plus a refundFailed flag, so it lands here rather than
          // the catch block below. It needs to stand out from a routine
          // success message: it means real M-Pesa money is stuck and
          // needs manual admin follow-up, not just an FYI.
          if (data.refundFailed) {
            setActionWarning(data.message);
          } else {
            setActionSuccess(data.message);
          }
          fetchDashboardData(); // Reload
        } catch (e: any) {
          setDataError(e.message);
        } finally {
          setAdminActionProcessing(false);
        }
      }
    });
  };

  const handleRejectAsSpam = async (itemId: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setReviewSaving(true);
    try {
      const response = await fetch(`/api/admin/items/${itemId}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: 'Admin manual-review queue rejection (Spam)' }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to reject as spam');
      }

      setActionSuccess('Item manual review: Item rejected as spam and removed from queue.');
      setSelectedReviewItem(null);
      fetchDashboardData();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setReviewSaving(false);
    }
  };

  // --- Stolen-property state machine & settlement release actions ---
  // The platform never adjudicates the underlying accusation — these calls
  // only ever change an item's claimability, and every reason given here is
  // recorded server-side in the audit log against the acting admin.
  const [itemActionProcessing, setItemActionProcessing] = useState<string | null>(null);

  const handleItemReviewStatusChange = async (itemId: string, action: 'flag-stolen' | 'legal-hold' | 'clear-hold', reason: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setItemActionProcessing(itemId + action);
    try {
      const response = await fetch(`/api/admin/items/${itemId}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Failed to ${action.replace('-', ' ')}`);
      }
      setActionSuccess(data.message || 'Item status updated.');
      fetchDashboardData();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setItemActionProcessing(null);
    }
  };

  const promptItemReviewStatusChange = (itemId: string, action: 'flag-stolen' | 'legal-hold' | 'clear-hold', promptLabel: string) => {
    const reason = window.prompt(promptLabel);
    if (reason === null) return; // cancelled
    if ((action === 'flag-stolen' || action === 'legal-hold') && !reason.trim()) {
      setDataError('A reason is required.');
      return;
    }
    handleItemReviewStatusChange(itemId, action, reason.trim());
  };

  const handleReleaseSettlementNow = async (claimId: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setItemActionProcessing('settlement:' + claimId);
    try {
      const response = await fetch(`/api/admin/claims/${claimId}/release-settlement`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to release settlement');
      }
      setActionSuccess(data.message || 'Settlement released.');
      fetchDashboardData();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setItemActionProcessing(null);
    }
  };

  const handleToggleSocialPause = async (paused: boolean) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');
    setItemActionProcessing('social-pause');
    try {
      const response = await fetch('/api/admin/settings/social-publishing-pause', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ paused }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update social publishing setting');
      }
      setActionSuccess(data.message || 'Setting updated.');
      fetchDashboardData();
    } catch (e: any) {
      setDataError(e.message);
    } finally {
      setItemActionProcessing(null);
    }
  };

  const handleClearReputation = (phone: string) => {
    setActionSuccess('');
    setActionWarning('');
    setDataError('');

    setConfirmModal({
      title: lang === 'en' ? 'Clear Reputation Flag' : 'Ondoa Bendera ya Sifa',
      message: lang === 'en'
        ? "Are you sure you want to clear this phone number's reputation flag?"
        : "Je, una uhakika unataka kuondoa bendera ya sifa mbaya kwenye nambari hii ya simu?",
      onConfirm: async () => {
        setAdminActionProcessing(true);
        try {
          const response = await fetch(`/api/admin/reputations/${phone}/clear`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
            }
          });

          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Failed to clear phone reputation');
          }

          setActionSuccess(`Reputation flag manually cleared for finder ${phone}.`);
          fetchDashboardData();
        } catch (e: any) {
          setDataError(e.message);
        } finally {
          setAdminActionProcessing(false);
        }
      }
    });
  };

  const splitsMatch = parseFloat((Number(catFormFinderShare) + Number(catFormAgentShare) + Number(catFormPlatformShare)).toFixed(2)) === parseFloat(Number(catFormTotalFee).toFixed(2));

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 fade-in">
      
      {/* 1. SECURE ADMIN PASSCODE LOGIN (No public signups allowed to prevent privilege-escalation) */}
      {!token && (
        <div className="bg-white rounded-3xl border border-stone-100 p-6 md:p-8 shadow-xl max-w-md mx-auto space-y-6">
          <div className="text-center space-y-2">
            <div className="w-12 h-12 bg-stone-900 text-white rounded-full flex items-center justify-center mx-auto">
              <ShieldCheck size={24} />
            </div>
            <h1 className="text-2xl font-extrabold text-stone-950">Admin Authentication</h1>
            <p className="text-stone-500 text-xs max-w-sm mx-auto">Access restricted strictly to platform executives and vetted managers.</p>
          </div>

          {authError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-2xl flex items-center space-x-2 text-xs">
              <AlertCircle size={16} />
              <span>{authError}</span>
            </div>
          )}

          <form onSubmit={pendingTwoFactorToken ? handleTwoFactorVerify : handleAdminAuth} className="space-y-4">
            {!pendingTwoFactorToken ? (
              <>
                <div className="space-y-1">
                  <label htmlFor="admin-username" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">Admin Username</label>
                  <input
                    id="admin-username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                    className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="admin-passcode" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">Access Password</label>
                  <input
                    id="admin-passcode"
                    type="password"
                    value={passcode}
                    onChange={(e) => setPasscode(e.target.value)}
                    placeholder="••••••••"
                    className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-sm font-mono"
                    required
                  />
                </div>
              </>
            ) : (
              <div className="space-y-1">
                <label htmlFor="admin-2fa-code" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                  6-Digit Authenticator Code
                </label>
                <input
                  id="admin-2fa-code"
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  maxLength={6}
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value)}
                  placeholder="123456"
                  className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-lg font-mono text-center tracking-widest"
                  required
                />
                <button
                  type="button"
                  onClick={() => { setPendingTwoFactorToken(null); setTwoFactorCode(''); setAuthError(''); }}
                  className="text-[11px] text-stone-400 hover:text-stone-600 underline"
                >
                  Back to password
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={pendingTwoFactorToken ? twoFactorLoading : authLoading}
              className="w-full bg-stone-900 hover:bg-stone-800 text-white py-3.5 rounded-2xl font-bold transition flex items-center justify-center space-x-2 cursor-pointer"
            >
              {(pendingTwoFactorToken ? twoFactorLoading : authLoading) ? (
                <Loader2 className="animate-spin" size={18} />
              ) : (
                <>
                  <span>{pendingTwoFactorToken ? 'Verify Code' : 'Unlock System Console'}</span>
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
        </div>
      )}

      {/* 2. DISTINCT LOADING / ERROR / EMPTY STATES */}
      {token && dashboardLoading && !dashboardData && (
        <div className="flex flex-col items-center justify-center py-20 space-y-4">
          <Loader2 className="animate-spin text-primary-green w-10 h-10" />
          <p className="text-stone-500 text-xs font-semibold uppercase tracking-wider animate-pulse">
            Fetching console dashboard statistics...
          </p>
        </div>
      )}

      {token && !dashboardData && dataError && (
        <div className="bg-red-50 border border-red-100 p-6 rounded-3xl max-w-md mx-auto text-center space-y-4 my-8">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto" />
          <h2 className="text-sm font-extrabold text-red-800">Failed to Load Dashboard</h2>
          <p className="text-xs text-red-600">{dataError}</p>
          <button onClick={fetchDashboardData} className="bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-4 py-2 rounded-xl transition">
            Retry Connection
          </button>
        </div>
      )}

      {token && !dashboardLoading && !dashboardData && !dataError && (
        <div className="bg-white rounded-3xl border border-stone-100 p-8 text-center space-y-4 shadow-sm max-w-md mx-auto my-8">
          <HelpCircle className="w-12 h-12 text-stone-300 mx-auto" />
          <h2 className="text-lg font-bold text-stone-800">No Dashboard Data Available</h2>
          <p className="text-xs text-stone-500">The console returned no statistical or audit record metrics at this time.</p>
          <button onClick={fetchDashboardData} className="bg-stone-900 text-white text-xs font-bold px-4 py-2 rounded-xl transition">
            Retry Fetching
          </button>
        </div>
      )}

      {/* 3. ADMIN DASHBOARD WORKSPACE */}
      {token && dashboardData && (
        <div className="space-y-6 fade-in">
          
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h1 className="text-3xl font-extrabold text-stone-900">{t.adminTitle}</h1>
              <p className="text-stone-500 text-xs mt-1">{t.adminSubtitle}</p>
            </div>
            <button
              onClick={fetchDashboardData}
              className="bg-stone-100 hover:bg-stone-200 p-2.5 rounded-xl border border-stone-200 text-stone-700 transition"
              title="Refresh Audit Data"
            >
              <RefreshCw size={16} />
            </button>
          </div>

          {actionSuccess && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-2xl text-xs font-bold flex items-center space-x-2">
              <CheckCircle size={16} />
              <span>{actionSuccess}</span>
            </div>
          )}

          {/* Social media publishing emergency stop — global, server-enforced,
              deliberately visible on every tab rather than tucked into
              settings. See isSocialPublishingPaused() in server.ts: every
              broadcast call site checks this before posting, and a failed
              check fails safe (treated as paused). */}
          <div className={`px-4 py-3 rounded-2xl text-xs font-bold flex flex-wrap items-center justify-between gap-2 border ${
            dashboardData.socialPublishingPaused ? 'bg-red-50 border-red-200 text-red-800' : 'bg-white border-stone-100 text-stone-500'
          }`}>
            <span className="flex items-center space-x-2">
              <ShieldAlert size={16} />
              <span>
                Social Media Publishing: {dashboardData.socialPublishingPaused ? 'PAUSED — no new posts will go out' : 'Active'}
              </span>
            </span>
            <button
              type="button"
              disabled={itemActionProcessing === 'social-pause'}
              onClick={() => handleToggleSocialPause(!dashboardData.socialPublishingPaused)}
              className={`text-[10px] font-black px-3.5 py-1.5 rounded-lg uppercase tracking-wider transition cursor-pointer disabled:opacity-50 ${
                dashboardData.socialPublishingPaused ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-red-600 hover:bg-red-700 text-white'
              }`}
            >
              {itemActionProcessing === 'social-pause' ? '...' : dashboardData.socialPublishingPaused ? 'Resume Publishing' : 'Pause All Publishing'}
            </button>
          </div>

          {/* The other five emergency pause scopes — reports, claims,
              payments, payouts, handovers. Same server-enforced, fail-safe
              pattern as the social-publishing stop above (see
              PAUSABLE_SCOPES / isPlatformOperationPaused in server.ts), just
              rendered as a compact grid since there are five of them. */}
          {pauseStatuses && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {([
                ['reports', 'New Reports'],
                ['claims', 'New Claims'],
                ['payments', 'Payments'],
                ['payouts', 'Payouts'],
                ['handovers', 'Handovers'],
              ] as const).map(([scope, label]) => {
                const isPaused = !!pauseStatuses[scope];
                const isBusy = itemActionProcessing === 'pause:' + scope;
                return (
                  <div
                    key={scope}
                    className={`px-3.5 py-2.5 rounded-2xl text-[11px] font-bold flex items-center justify-between gap-2 border ${
                      isPaused ? 'bg-red-50 border-red-200 text-red-800' : 'bg-white border-stone-100 text-stone-500'
                    }`}
                  >
                    <span className="flex items-center space-x-1.5">
                      <ShieldAlert size={14} />
                      <span>{label}: {isPaused ? 'PAUSED' : 'Active'}</span>
                    </span>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleTogglePause(scope, !isPaused)}
                      className={`text-[9px] font-black px-2.5 py-1 rounded-lg uppercase tracking-wider transition cursor-pointer disabled:opacity-50 shrink-0 ${
                        isPaused ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-red-600 hover:bg-red-700 text-white'
                      }`}
                    >
                      {isBusy ? '...' : isPaused ? 'Resume' : 'Pause'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {actionWarning && (
            <div className="bg-amber-50 border border-amber-300 text-amber-900 px-4 py-3 rounded-2xl text-xs font-bold flex items-center space-x-2">
              <AlertTriangle size={16} />
              <span>{actionWarning}</span>
            </div>
          )}

          {dataError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-2xl text-xs flex items-center space-x-2">
              <AlertCircle size={16} />
              <span>{dataError}</span>
            </div>
          )}

          {/* Tab Navigation */}
          <div className="flex border-b border-stone-200 overflow-x-auto scrollbar-none">
            <button
              onClick={() => setActiveTab('stats')}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'stats' ? 'border-stone-900 text-stone-950 font-extrabold' : 'border-transparent text-stone-400'
              }`}
            >
              <BarChart2 size={14} />
              <span>{t.statsTab}</span>
            </button>
            <button
              onClick={() => setActiveTab('agents')}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'agents' ? 'border-stone-900 text-stone-950 font-extrabold' : 'border-transparent text-stone-400'
              }`}
            >
              <Users size={14} />
              <span>{lang === 'en' ? 'Agents Hub' : 'Mawakala'}</span>
            </button>
            <button
              onClick={() => setActiveTab('found_items')}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'found_items' ? 'border-stone-900 text-stone-950 font-extrabold' : 'border-transparent text-stone-400'
              }`}
            >
              <Package size={14} />
              <span>{lang === 'en' ? 'Found Items' : 'Vitu Vilivyopatikana'}</span>
            </button>
            <button
              onClick={() => setActiveTab('disputes')}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'disputes' ? 'border-stone-900 text-stone-950 font-extrabold' : 'border-transparent text-stone-400'
              }`}
            >
              <HelpCircle size={14} />
              <span>{t.disputesTab}</span>
            </button>
            <button
              onClick={() => setActiveTab('ledger')}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'ledger' ? 'border-stone-900 text-stone-950 font-extrabold' : 'border-transparent text-stone-400'
              }`}
            >
              <Coins size={14} />
              <span>{t.ledgerTab}</span>
            </button>
            <button
              onClick={() => setActiveTab('review')}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'review' ? 'border-stone-900 text-stone-950 font-extrabold' : 'border-transparent text-stone-400'
              }`}
            >
              <FileCheck size={14} />
              <span>Manual Review</span>
            </button>
            <button
              onClick={() => setActiveTab('categories')}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'categories' ? 'border-stone-900 text-stone-950 font-extrabold' : 'border-transparent text-stone-400'
              }`}
            >
              <Coins size={14} />
              <span>{t.categoriesTab}</span>
            </button>
            <button
              onClick={() => setActiveTab('strikes')}
              className={`py-3 px-6 text-xs font-bold transition border-b-2 -mb-px flex items-center space-x-1.5 shrink-0 ${
                activeTab === 'strikes' ? 'border-stone-900 text-stone-950 font-extrabold' : 'border-transparent text-stone-400'
              }`}
            >
              <ShieldAlert size={14} />
              <span>Payment Strikes</span>
            </button>
          </div>

          {/* TAB CONTENT 1: STATS WORKSPACE */}
          {activeTab === 'stats' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-white border border-stone-100 p-5 rounded-2xl shadow-sm text-center space-y-1">
                  <span className="text-stone-400 text-[10px] font-extrabold uppercase tracking-widest">Active Holding Items</span>
                  <span className="text-2xl font-black text-primary-green block">{dashboardData.stats.itemsAtAgentCount}</span>
                </div>
                <div className="bg-white border border-stone-100 p-5 rounded-2xl shadow-sm text-center space-y-1">
                  <span className="text-stone-400 text-[10px] font-extrabold uppercase tracking-widest">Pending Agents</span>
                  <span className="text-2xl font-black text-accent-orange block">{dashboardData.stats.pendingAgentsCount}</span>
                </div>
                <div className="bg-white border border-stone-100 p-5 rounded-2xl shadow-sm text-center space-y-1">
                  <span className="text-stone-400 text-[10px] font-extrabold uppercase tracking-widest">Escrow Funds Held</span>
                  <span className="text-2xl font-black text-emerald-700 block">{dashboardData.stats.escrowHeldCount}</span>
                </div>
                <div className="bg-white border border-stone-100 p-5 rounded-2xl shadow-sm text-center space-y-1">
                  <span className="text-stone-400 text-[10px] font-extrabold uppercase tracking-widest">{t.totalRev}</span>
                  <span className="text-2xl font-black text-stone-900 block">KES {dashboardData.stats.totalRevenue}</span>
                </div>
              </div>

              {/* Admin 2FA / Security */}
              <div className="bg-white border border-stone-100 rounded-3xl p-6 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-extrabold text-sm text-stone-500 uppercase tracking-widest flex items-center gap-2">
                    <ShieldCheck size={16} />
                    Two-Factor Authentication (2FA)
                  </h3>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full ${adminTotpEnabled ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-500'}`}>
                    {adminTotpEnabled ? 'Enabled' : 'Not Enabled'}
                  </span>
                </div>

                {twoFaError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-xl text-xs">{twoFaError}</div>
                )}
                {twoFaMessage && (
                  <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-3 py-2 rounded-xl text-xs">{twoFaMessage}</div>
                )}

                {!adminTotpEnabled && !twoFaSetupData && (
                  <div className="space-y-2">
                    <p className="text-xs text-stone-500">
                      This admin account does not have 2FA enabled. Given this account controls dispute resolution, agent approval, and the full financial ledger, we strongly recommend enabling it.
                    </p>
                    <button
                      onClick={handleTwoFaStartSetup}
                      disabled={twoFaProcessing}
                      className="bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold px-4 py-2 rounded-xl transition disabled:opacity-50"
                    >
                      {twoFaProcessing ? 'Starting...' : 'Enable 2FA'}
                    </button>
                  </div>
                )}

                {twoFaSetupData && (
                  <div className="space-y-3 bg-stone-50 border border-stone-200 rounded-2xl p-4">
                    <p className="text-xs text-stone-600">
                      Add this account to Google Authenticator, Authy, or any TOTP app — either by scanning a QR code generated from the URL below, or by entering the secret manually.
                    </p>
                    <div className="text-[10px] font-mono bg-white border border-stone-200 rounded-lg p-2 break-all">{twoFaSetupData.otpauthUrl}</div>
                    <div className="text-xs">
                      <span className="font-bold">Manual entry secret:</span>{' '}
                      <span className="font-mono">{twoFaSetupData.secret}</span>
                    </div>
                    <form onSubmit={handleTwoFaConfirm} className="flex gap-2 items-end">
                      <div className="flex-1 space-y-1">
                        <label htmlFor="twofa-confirm-code" className="text-[10px] font-bold text-stone-500 uppercase">Enter code to confirm</label>
                        <input
                          id="twofa-confirm-code"
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          value={twoFaConfirmCode}
                          onChange={(e) => setTwoFaConfirmCode(e.target.value)}
                          placeholder="123456"
                          className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm font-mono text-center"
                          required
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={twoFaProcessing}
                        className="bg-primary-green text-white text-xs font-bold px-4 py-2 rounded-xl transition disabled:opacity-50"
                      >
                        Confirm &amp; Enable
                      </button>
                    </form>
                  </div>
                )}

                {adminTotpEnabled && !twoFaShowDisableForm && (
                  <button
                    onClick={() => setTwoFaShowDisableForm(true)}
                    className="text-xs font-bold text-red-600 hover:text-red-700 underline"
                  >
                    Disable 2FA
                  </button>
                )}

                {adminTotpEnabled && twoFaShowDisableForm && (
                  <form onSubmit={handleTwoFaDisable} className="flex gap-2 items-end bg-red-50/50 border border-red-100 rounded-2xl p-4">
                    <div className="flex-1 space-y-1">
                      <label htmlFor="twofa-disable-password" className="text-[10px] font-bold text-red-800 uppercase">Confirm password to disable 2FA</label>
                      <input
                        id="twofa-disable-password"
                        type="password"
                        value={twoFaDisablePassword}
                        onChange={(e) => setTwoFaDisablePassword(e.target.value)}
                        className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm"
                        required
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={twoFaProcessing}
                      className="bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-4 py-2 rounded-xl transition disabled:opacity-50"
                    >
                      Disable
                    </button>
                  </form>
                )}
              </div>

              {/* Audit logs timeline */}
              <div className="bg-white border border-stone-100 rounded-3xl p-6 shadow-sm space-y-4">
                <h3 className="font-extrabold text-sm text-stone-500 uppercase tracking-widest">Real-time Platform Audit Logs</h3>
                <div className="h-60 overflow-y-auto border border-stone-100 rounded-xl font-mono text-[10px] p-4 bg-brand-beige space-y-2 leading-tight">
                  {dashboardData.auditLogs.map((log: any) => (
                    <div key={log.id} className="text-stone-600 border-b border-stone-200/50 pb-1.5 flex justify-between items-start">
                      <div>
                        <span className="text-primary-green font-bold mr-2">[{log.action.toUpperCase()}]</span>
                        <span>{log.details}</span>
                      </div>
                      <span className="text-stone-400 shrink-0 ml-3">{new Date(log.created_at).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB CONTENT 2: AGENTS VETTING & DIRECTORY */}
          {activeTab === 'agents' && (
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <h2 className="text-lg font-bold text-primary-green">
                    {lang === 'en' ? 'Agents Directory & Vetting Hub' : 'Saraka ya Mawakala na Kitovu cha Uhakiki'}
                  </h2>
                  <p className="text-stone-500 text-xs">
                    {lang === 'en' 
                      ? 'Monitor registered physical drop-off stations, approve pending applications, or suspend active hubs.' 
                      : 'Fuatilia vituo vya mawakala wa makabidhiano, idhinisha mawakala wapya, au msimamishe kazi wakala.'}
                  </p>
                </div>
              </div>

              {/* Search & Filters */}
              <div className="bg-white border border-stone-100 rounded-2xl p-4 shadow-sm flex flex-col sm:flex-row gap-3">
                <div className="flex-1">
                  <input
                    type="text"
                    value={agentSearch}
                    onChange={(e) => setAgentSearch(e.target.value)}
                    placeholder={lang === 'en' ? 'Search by business name, phone, email, till...' : 'Tafuta kwa jina la biashara, simu, barua pepe...'}
                    aria-label={lang === 'en' ? 'Search agents' : 'Tafuta mawakala'}
                    className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-accent-orange"
                  />
                </div>
                <div className="flex gap-2">
                  <select
                    value={agentStatusFilter}
                    onChange={(e) => setAgentStatusFilter(e.target.value)}
                    aria-label={lang === 'en' ? 'Filter by agent status' : 'Chuja kwa hali ya wakala'}
                    className="border border-stone-200 rounded-xl px-3 py-2 text-xs bg-white font-semibold focus:outline-none"
                  >
                    <option value="all">{lang === 'en' ? 'All Statuses' : 'Hali Zote'}</option>
                    <option value="pending">{lang === 'en' ? 'Pending Approval' : 'Wanasubiri Uhakiki'}</option>
                    <option value="active">{lang === 'en' ? 'Active Hubs' : 'Mawakala Wanaofanya Kazi'}</option>
                    <option value="suspended">{lang === 'en' ? 'Suspended Hubs' : 'Waliosimamishwa Kazi'}</option>
                  </select>
                </div>
              </div>

              {/* Agent List */}
              {(() => {
                const filteredAgents = dashboardData.agents.filter((a: any) => {
                  const query = agentSearch.toLowerCase().trim();
                  const matchesSearch = !query || 
                    (a.business_name && a.business_name.toLowerCase().includes(query)) ||
                    (a.contact_phone && a.contact_phone.toLowerCase().includes(query)) ||
                    (a.contact_email && a.contact_email.toLowerCase().includes(query)) ||
                    (a.mpesa_till_or_paybill && a.mpesa_till_or_paybill.toLowerCase().includes(query)) ||
                    (a.location_address && a.location_address.toLowerCase().includes(query)) ||
                    (a.id && a.id.toLowerCase().includes(query));
                  
                  const matchesFilter = agentStatusFilter === 'all' || a.status === agentStatusFilter;
                  return matchesSearch && matchesFilter;
                });

                if (filteredAgents.length === 0) {
                  return (
                    <div className="bg-white border border-stone-100 rounded-2xl p-8 text-center text-stone-400 text-xs">
                      {lang === 'en' ? 'No agents found matching your criteria.' : 'Hakuna mawakala waliopatikana wanaolingana na vigezo vyako.'}
                    </div>
                  );
                }

                return (
                  <div className="space-y-3">
                    {filteredAgents.map((agent: any) => {
                      const isExpanded = expandedAgentId === agent.id;
                      return (
                        <div 
                          key={agent.id} 
                          className="bg-white border border-stone-100 rounded-2xl shadow-sm hover:border-stone-200 transition overflow-hidden"
                        >
                          {/* Core Row Header */}
                          <div 
                            onClick={() => setExpandedAgentId(isExpanded ? null : agent.id)}
                            className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 cursor-pointer hover:bg-stone-50 transition"
                            role="button"
                            tabIndex={0}
                            aria-expanded={isExpanded}
                            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} details for ${agent.business_name}`}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setExpandedAgentId(isExpanded ? null : agent.id);
                              }
                            }}
                          >
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`text-[9px] font-black px-2.5 py-0.5 rounded-full uppercase ${
                                  agent.status === 'active' 
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' 
                                    : agent.status === 'pending'
                                    ? 'bg-amber-50 text-amber-700 border border-amber-100'
                                    : 'bg-red-50 text-red-700 border border-red-100'
                                }`}>
                                  {agent.status}
                                </span>
                                {agent.needs_manual_geocoding && (
                                  <span className="bg-red-50 text-red-600 text-[9px] font-black px-2 py-0.5 rounded-full border border-red-100 uppercase">
                                    Needs Geocoding
                                  </span>
                                )}
                                <span className="text-[10px] text-stone-400 font-mono">ID: {agent.id}</span>
                              </div>
                              <h3 className="font-extrabold text-stone-900 text-sm md:text-base">{agent.business_name}</h3>
                              <p className="text-stone-500 text-xs line-clamp-1">{agent.location_address}</p>
                            </div>

                            <div className="flex items-center gap-3 self-stretch md:self-auto justify-between md:justify-end">
                              <div className="text-right hidden md:block">
                                <div className="text-xs font-bold text-emerald-700">KES {(agent.total_earned || 0).toLocaleString()} {lang === 'en' ? 'earned' : 'iliyopatikana'}</div>
                                <div className="text-[10px] text-stone-400 font-mono">{agent.contact_phone} · Till: {agent.mpesa_till_or_paybill}</div>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedAgentId(isExpanded ? null : agent.id);
                                  }}
                                  className="text-stone-500 hover:text-stone-800 text-xs font-bold px-3 py-1.5 rounded-lg border border-stone-200 hover:border-stone-300 transition"
                                >
                                  {isExpanded ? (lang === 'en' ? 'Hide Details' : 'Ficha') : (lang === 'en' ? 'View Details' : 'Angalia')}
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* Expanded Details Body */}
                          {isExpanded && (
                            <div className="border-t border-stone-100 bg-stone-50/50 p-5 space-y-4 animate-fade-in text-xs text-stone-600">
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                {/* Column 1: Verification / Details */}
                                <div className="space-y-2">
                                  <span className="text-[10px] font-extrabold text-stone-400 uppercase tracking-wider block">Agent Contact Details</span>
                                  <p><b>Business Name:</b> {agent.business_name}</p>
                                  <p><b>Contact Phone:</b> {agent.contact_phone}</p>
                                  <p><b>Contact Email:</b> {agent.contact_email || 'Not Provided'}</p>
                                  <p><b>National ID Hash:</b> <span className="font-mono text-[10px] break-all block p-1.5 bg-stone-100 rounded-lg">{agent.national_id_hash || 'None'}</span></p>
                                  <p className="pt-1">
                                    <b>Total Earned:</b>{' '}
                                    <span className="text-emerald-700 font-extrabold">KES {(agent.total_earned || 0).toLocaleString()}</span>
                                    {' '}<span className="text-stone-400">({agent.completed_payouts_count || 0} completed handovers)</span>
                                  </p>
                                </div>

                                {/* Column 2: Location and Map */}
                                <div className="space-y-2">
                                  <span className="text-[10px] font-extrabold text-stone-400 uppercase tracking-wider block">Physical Coordinates</span>
                                  <p><b>Full Address:</b> {agent.location_address}</p>
                                  {agent.latitude && agent.longitude ? (
                                    <>
                                      <p><b>Latitude:</b> {parseFloat(agent.latitude).toFixed(6)}</p>
                                      <p><b>Longitude:</b> {parseFloat(agent.longitude).toFixed(6)}</p>
                                      <a 
                                        href={`https://www.google.com/maps/search/?api=1&query=${agent.latitude},${agent.longitude}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-primary-green hover:underline font-bold inline-flex items-center space-x-1"
                                      >
                                        <span>🌐 View on Google Maps</span>
                                      </a>
                                    </>
                                  ) : (
                                    <div className="space-y-2">
                                      <p className="text-red-500 font-bold">⚠️ GPS coordinates unavailable — this agent cannot receive GPS-matched items until fixed</p>
                                      {locationFormAgentId === agent.id ? (
                                        <div className="flex flex-wrap items-end gap-2 p-2 bg-white border border-stone-200 rounded-xl">
                                          <div>
                                            <label htmlFor={`agent-lat-${agent.id}`} className="text-[9px] font-bold text-stone-500 block">Latitude</label>
                                            <input
                                              id={`agent-lat-${agent.id}`}
                                              type="text"
                                              value={locationFormLat}
                                              onChange={(e) => setLocationFormLat(e.target.value)}
                                              placeholder="-1.286389"
                                              className="w-28 border border-stone-200 rounded-lg px-2 py-1 text-xs font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label htmlFor={`agent-lon-${agent.id}`} className="text-[9px] font-bold text-stone-500 block">Longitude</label>
                                            <input
                                              id={`agent-lon-${agent.id}`}
                                              type="text"
                                              value={locationFormLon}
                                              onChange={(e) => setLocationFormLon(e.target.value)}
                                              placeholder="36.817223"
                                              className="w-28 border border-stone-200 rounded-lg px-2 py-1 text-xs font-mono"
                                            />
                                          </div>
                                          <button
                                            type="button"
                                            disabled={adminActionProcessing}
                                            onClick={() => handleSetAgentLocation(agent.id)}
                                            className="bg-primary-green hover:bg-primary-hover text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition disabled:opacity-50"
                                          >
                                            Save
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => setLocationFormAgentId(null)}
                                            className="bg-stone-100 hover:bg-stone-200 text-stone-600 text-[10px] font-bold px-3 py-1.5 rounded-lg transition"
                                          >
                                            Cancel
                                          </button>
                                          <a
                                            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(agent.location_address)}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-primary-green hover:underline text-[10px] font-bold"
                                          >
                                            🔍 Look up on Google Maps
                                          </a>
                                        </div>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => { setLocationFormAgentId(agent.id); setLocationFormLat(''); setLocationFormLon(''); }}
                                          className="bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 text-[10px] font-extrabold px-3 py-1.5 rounded-lg transition"
                                        >
                                          Set Coordinates Manually
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  <p><b>Date Registered:</b> {new Date(agent.created_at).toLocaleDateString()} {new Date(agent.created_at).toLocaleTimeString()}</p>
                                </div>

                                {/* Column 3: Performance, Finance & Warnings */}
                                <div className="space-y-2">
                                  <span className="text-[10px] font-extrabold text-stone-400 uppercase tracking-wider block">Financials, Rating & Warnings</span>
                                  <p><b>Payout Method:</b> {agent.payout_method_type || 'Till Number'}</p>
                                  <p><b>M-Pesa Target:</b> {agent.mpesa_till_or_paybill}</p>
                                  <p><b>Refundable Security Deposit:</b> KES {parseFloat(agent.refundable_deposit || '0').toLocaleString()}</p>
                                  <p className="flex items-center gap-1.5">
                                    <b>Rating Score:</b> 
                                    <span className="bg-amber-50 text-amber-800 font-extrabold px-2 py-0.5 rounded border border-amber-100 flex items-center gap-0.5">
                                      ★ {parseFloat(agent.rating || '5.0').toFixed(1)}
                                    </span>
                                    <span>({agent.rating_count || 0} reviews)</span>
                                  </p>
                                  <div className="bg-red-50 border border-red-100 p-2 rounded-xl space-y-1 mt-1">
                                    <p className="font-bold text-red-800 text-[11px]">⚠️ Warnings: {agent.warning_count || 0}</p>
                                    {agent.last_warning_reason && (
                                      <p className="text-[10px] text-red-600 italic">"Last: {agent.last_warning_reason}"</p>
                                    )}
                                  </div>
                                </div>
                              </div>

                              {/* Shop Front & ID Photos Viewer */}
                              {(agent.shop_photo_url || agent.id_document_photo_url) && (
                                <div className="border-t border-stone-200/60 pt-3 space-y-2">
                                  <span className="text-[10px] font-extrabold text-stone-400 uppercase tracking-wider block">Agent Verification Photographs</span>
                                  <div className="flex flex-wrap gap-4">
                                    {agent.shop_photo_url && (
                                      <div 
                                        onClick={() => setLightboxImage(agent.shop_photo_url)}
                                        className="cursor-pointer space-y-1 group"
                                        role="button"
                                        tabIndex={0}
                                        aria-label="View shop / business location photo full-size"
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            setLightboxImage(agent.shop_photo_url);
                                          }
                                        }}
                                      >
                                        <p className="text-[10px] font-bold text-stone-600">Shop / Business Location Front</p>
                                        <div className="w-32 h-24 rounded-xl border border-stone-200 overflow-hidden bg-stone-100 relative">
                                          <img src={agent.shop_photo_url} alt="Shop Front" className="w-full h-full object-cover group-hover:scale-105 transition" />
                                        </div>
                                      </div>
                                    )}
                                    {agent.id_document_photo_url && (
                                      <div 
                                        onClick={() => setLightboxImage(agent.id_document_photo_url)}
                                        className="cursor-pointer space-y-1 group"
                                        role="button"
                                        tabIndex={0}
                                        aria-label="View national ID document photo full-size"
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            setLightboxImage(agent.id_document_photo_url);
                                          }
                                        }}
                                      >
                                        <p className="text-[10px] font-bold text-stone-600">National ID Document Photo</p>
                                        <div className="w-32 h-24 rounded-xl border border-stone-200 overflow-hidden bg-stone-100 relative">
                                          <img src={agent.id_document_photo_url} alt="ID Document" className="w-full h-full object-cover group-hover:scale-105 transition" />
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}

                              {/* Actions on this Agent */}
                              <div className="border-t border-stone-200/60 pt-4 flex flex-wrap justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleWarnAgent(agent.id)}
                                  disabled={adminActionProcessing}
                                  className="bg-amber-600 hover:bg-amber-700 text-white font-bold px-4 py-2 rounded-xl transition flex items-center space-x-1 disabled:opacity-50 cursor-pointer"
                                >
                                  <span>Issue Warning</span>
                                </button>
                                {agent.status === 'pending' && (
                                  <button
                                    type="button"
                                    onClick={() => handleApproveAgent(agent.id)}
                                    disabled={adminActionProcessing}
                                    className="bg-primary-green hover:bg-primary-hover text-white font-bold px-4 py-2 rounded-xl transition flex items-center space-x-1 disabled:opacity-50 cursor-pointer"
                                  >
                                    <span>{t.approveBtn}</span>
                                  </button>
                                )}

                                {agent.status === 'active' && (
                                  <button
                                    type="button"
                                    onClick={() => handleSuspendAgent(agent.id)}
                                    disabled={adminActionProcessing}
                                    className="bg-red-600 hover:bg-red-700 text-white font-bold px-4 py-2 rounded-xl transition flex items-center space-x-1 disabled:opacity-50 cursor-pointer"
                                  >
                                    <span>Suspend Agent</span>
                                  </button>
                                )}

                                {agent.status === 'suspended' && (
                                  <button
                                    type="button"
                                    onClick={() => handleApproveAgent(agent.id)}
                                    disabled={adminActionProcessing}
                                    className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-4 py-2 rounded-xl transition flex items-center space-x-1 disabled:opacity-50 cursor-pointer"
                                  >
                                    <span>Re-Activate Agent</span>
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* TAB CONTENT: ALL FOUND ITEMS REAL-TIME DIRECTORY */}
          {activeTab === 'found_items' && (
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <h2 className="text-lg font-bold text-primary-green">
                    {lang === 'en' ? 'Found Items Real-Time Ledger' : 'Sajili ya Vitu Vilivyopatikana'}
                  </h2>
                  <p className="text-stone-500 text-xs">
                    {lang === 'en' 
                      ? 'Live real-time registry of all items uploaded by finders. Track drop-off states, assigned hubs, and claimed assets.' 
                      : 'Orodha ya moja kwa moja ya vitu vyote vilivyowasilishwa na wavumbuzi. Fuatilia makabidhiano na madai.'}
                  </p>
                </div>
              </div>

              {/* Filters Panel */}
              <div className="bg-white border border-stone-100 rounded-3xl p-5 shadow-sm space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  {/* Search bar */}
                  <div className="md:col-span-2 space-y-1">
                    <label htmlFor="item-search" className="text-[10px] font-bold text-stone-400 uppercase tracking-wider">Search Items</label>
                    <input
                      id="item-search"
                      type="text"
                      value={itemSearch}
                      onChange={(e) => setItemSearch(e.target.value)}
                      placeholder="Search by Code, OCR info, Location, Phone..."
                      className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-accent-orange"
                    />
                  </div>

                  {/* Status filter */}
                  <div className="space-y-1">
                    <label htmlFor="item-status-filter" className="text-[10px] font-bold text-stone-400 uppercase tracking-wider">Hali / Status</label>
                    <select
                      id="item-status-filter"
                      value={itemStatusFilter}
                      onChange={(e) => setItemStatusFilter(e.target.value)}
                      className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs bg-white font-medium focus:outline-none"
                    >
                      <option value="all">All Statuses</option>
                      <option value="awaiting_dropoff">Awaiting Drop-off</option>
                      <option value="at_agent">At Agent Station</option>
                      <option value="claimed">Claimed & Handed Over</option>
                      <option value="expired">Expired</option>
                      <option value="suspected_stolen">Suspected Stolen</option>
                      <option value="legal_hold">Legal Hold</option>
                    </select>
                  </div>

                  {/* Flagged filter */}
                  <div className="space-y-1">
                    <label htmlFor="item-flag-filter" className="text-[10px] font-bold text-stone-400 uppercase tracking-wider">Review Flag</label>
                    <select
                      id="item-flag-filter"
                      value={itemFlagFilter}
                      onChange={(e) => setItemFlagFilter(e.target.value)}
                      className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs bg-white font-medium focus:outline-none"
                    >
                      <option value="all">All Items</option>
                      <option value="flagged">Flagged for Review</option>
                      <option value="normal">Normal / Approved</option>
                    </select>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-1 border-t border-stone-100/60">
                  <span className="text-[10px] font-bold text-stone-400 self-center uppercase tracking-wider mr-1">Quick Categories:</span>
                  <button
                    onClick={() => setItemCategoryFilter('all')}
                    className={`px-3 py-1 text-[10px] font-black rounded-full transition cursor-pointer ${
                      itemCategoryFilter === 'all' 
                        ? 'bg-stone-900 text-white' 
                        : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                    }`}
                  >
                    All Categories
                  </button>
                  {categories.map((cat: any) => (
                    <button
                      key={cat.id}
                      onClick={() => setItemCategoryFilter(cat.id)}
                      className={`px-3 py-1 text-[10px] font-black rounded-full transition cursor-pointer ${
                        itemCategoryFilter === cat.id 
                          ? 'bg-stone-900 text-white' 
                          : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                      }`}
                    >
                      {lang === 'en' ? cat.name_en : cat.name_sw}
                    </button>
                  ))}
                </div>
              </div>

              {/* Items Render Grid */}
              {(() => {
                const filteredItems = dashboardData.items.filter((item: any) => {
                  const query = itemSearch.toLowerCase().trim();
                  const matchesSearch = !query ||
                    (item.id && item.id.toLowerCase().includes(query)) ||
                    (item.ocr_extracted_number && item.ocr_extracted_number.toLowerCase().includes(query)) ||
                    (item.ocr_extracted_name && item.ocr_extracted_name.toLowerCase().includes(query)) ||
                    (item.location_description && item.location_description.toLowerCase().includes(query)) ||
                    (item.finder_phone && item.finder_phone.toLowerCase().includes(query)) ||
                    (item.description && item.description.toLowerCase().includes(query));

                  const matchesStatus = itemStatusFilter === 'all' || item.status === itemStatusFilter;
                  const matchesCategory = itemCategoryFilter === 'all' || item.category_id === itemCategoryFilter;
                  const matchesFlag = itemFlagFilter === 'all' || 
                    (itemFlagFilter === 'flagged' && item.flaggedForReview) ||
                    (itemFlagFilter === 'normal' && !item.flaggedForReview);

                  return matchesSearch && matchesStatus && matchesCategory && matchesFlag;
                });

                if (filteredItems.length === 0) {
                  return (
                    <div className="bg-white border border-stone-100 rounded-3xl p-12 text-center text-stone-400 text-xs">
                      {lang === 'en' ? 'No found items match your filters.' : 'Hakuna vitu vilivyopatikana vinavyolingana na vigezo vyako.'}
                    </div>
                  );
                }

                return (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {filteredItems.map((item: any) => {
                      // Lookup agent
                      const agentObj = dashboardData.agents.find((a: any) => a.id === item.assigned_agent_id);
                      return (
                        <div key={item.id} className="bg-white border border-stone-100 rounded-3xl p-5 shadow-sm hover:border-stone-200 transition flex flex-col md:flex-row gap-5">
                          {/* Image Thumbnail with zoom trigger */}
                          <div 
                            onClick={() => setLightboxImage(item.photo_url)}
                            className="w-full md:w-36 h-36 rounded-2xl bg-stone-50 border border-stone-100 overflow-hidden shrink-0 flex items-center justify-center cursor-zoom-in relative group"
                            role="button"
                            tabIndex={0}
                            aria-label="View item photo full-size"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setLightboxImage(item.photo_url);
                              }
                            }}
                          >
                            <img
                              src={item.photo_url}
                              alt="Item Photograph"
                              className="w-full h-full object-contain group-hover:scale-105 transition duration-300"
                              referrerPolicy="no-referrer"
                            />
                            <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                              <span className="text-white text-[10px] font-black bg-stone-900/80 px-2 py-1 rounded-md uppercase tracking-wider">Zoom View</span>
                            </div>
                          </div>

                          {/* Item Details Column */}
                          <div className="flex-1 flex flex-col justify-between space-y-3 min-w-0">
                            <div className="space-y-1.5">
                              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 pb-2">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-mono font-black text-stone-900">CODE: {item.id}</span>
                                  {item.flaggedForReview && (
                                    <span className="bg-red-50 text-red-600 text-[9px] font-black px-2 py-0.5 rounded-full border border-red-100 animate-pulse">
                                      Flagged
                                    </span>
                                  )}
                                </div>
                                <span className={`text-[9px] font-extrabold px-2 py-0.5 rounded-full uppercase ${
                                  item.status === 'claimed'
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                                    : item.status === 'at_agent'
                                    ? 'bg-blue-50 text-blue-700 border border-blue-100'
                                    : item.status === 'awaiting_dropoff'
                                    ? 'bg-amber-50 text-amber-700 border border-amber-100'
                                    : item.status === 'suspected_stolen' || item.status === 'legal_hold'
                                    ? 'bg-red-50 text-red-700 border border-red-200'
                                    : 'bg-stone-100 text-stone-700 border border-stone-200'
                                }`}>
                                  {item.status === 'awaiting_dropoff' ? 'awaiting drop-off' : item.status === 'suspected_stolen' ? 'suspected stolen' : item.status === 'legal_hold' ? 'legal hold' : item.status}
                                </span>
                              </div>

                              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                                <div>
                                  <span className="text-[10px] text-stone-400 block">Category</span>
                                  <span className="font-bold text-stone-800">
                                    {categories.find((c: any) => c.id === item.category_id)?.name_en || item.category_id}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[10px] text-stone-400 block">Date Reported</span>
                                  <span className="font-medium text-stone-800">
                                    {new Date(item.created_at).toLocaleDateString()}
                                  </span>
                                </div>
                                
                                {/* OCR / Description Details */}
                                <div className="col-span-2 pt-1 border-t border-stone-50">
                                  {item.is_description_only || item.isDescriptionOnly ? (
                                    <div>
                                      <span className="text-[10px] text-stone-400 block">Description</span>
                                      <p className="text-stone-700 text-[11px] leading-normal italic font-medium">"{item.description}"</p>
                                    </div>
                                  ) : (
                                    <div className="grid grid-cols-2 gap-2">
                                      <div>
                                        <span className="text-[10px] text-stone-400 block">Extracted Number</span>
                                        <span className="font-mono font-bold text-stone-800 break-all">{item.ocr_extracted_number || 'None'}</span>
                                      </div>
                                      <div>
                                        <span className="text-[10px] text-stone-400 block">Extracted Name</span>
                                        <span className="font-sans font-extrabold text-stone-800 uppercase line-clamp-1">{item.ocr_extracted_name || 'None'}</span>
                                      </div>
                                    </div>
                                  )}
                                </div>

                                {/* Matching Stats & Location details */}
                                <div className="col-span-2 pt-1 border-t border-stone-50 text-[11px]">
                                  <p className="text-stone-500">
                                    📍 <b>Location:</b> {item.location_description}
                                  </p>
                                  {item.latitude && item.longitude && (
                                    <p className="text-stone-400 font-mono text-[10px] mt-0.5">
                                      GPS: {parseFloat(item.latitude).toFixed(4)}, {parseFloat(item.longitude).toFixed(4)}
                                    </p>
                                  )}
                                </div>

                                {/* Finder phone and reputation */}
                                <div className="col-span-2 pt-1.5 border-t border-stone-100 bg-stone-50 p-2 rounded-xl text-[11px]">
                                  <p className="font-bold text-stone-700">Finder Information:</p>
                                  <div className="flex justify-between mt-1 text-stone-600">
                                    <span>Phone: <b>{item.finder_phone}</b></span>
                                    {item.reputation && (
                                      <span>Reputation: <b>{item.reputation.rejected_reports}/{item.reputation.total_reports} rejected</b></span>
                                    )}
                                  </div>
                                </div>

                                {/* Assigned Agent Hub details */}
                                <div className="col-span-2 pt-1.5 border-t border-stone-50 text-[11px]">
                                  <span className="text-[10px] text-stone-400 block">Assigned Physical Agent Station</span>
                                  {agentObj ? (
                                    <div className="mt-0.5 flex justify-between items-center bg-brand-beige p-2 rounded-xl border border-stone-200/50">
                                      <div>
                                        <p className="font-extrabold text-stone-800">{agentObj.business_name}</p>
                                        <p className="text-[10px] text-stone-500 line-clamp-1">{agentObj.location_address}</p>
                                      </div>
                                      {item.agent_assignment_distance_km !== null && (
                                        <span className="bg-stone-100 text-stone-700 font-mono text-[9px] px-2 py-0.5 rounded-md font-bold shrink-0">
                                          {parseFloat(item.agent_assignment_distance_km).toFixed(1)} km
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-red-500 font-bold block">No Assigned Agent (Error)</span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Action to correct / review */}
                            {item.flaggedForReview && (
                              <div className="pt-2 border-t border-stone-100 flex justify-end">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActiveTab('review');
                                    startReview(item);
                                  }}
                                  className="bg-stone-900 hover:bg-stone-800 text-white text-[10px] font-black px-3.5 py-1.5 rounded-lg uppercase tracking-wider transition cursor-pointer"
                                >
                                  Fix Details / Reassign Hub
                                </button>
                              </div>
                            )}

                            {/* Stolen-property state machine controls — the platform
                                never publishes an accusation; this only ever changes
                                claimability, and a reason is required and audit-logged
                                for every transition. */}
                            <div className="pt-2 border-t border-stone-100 flex flex-wrap justify-end gap-2">
                              {(item.status === 'suspected_stolen' || item.status === 'legal_hold') ? (
                                <button
                                  type="button"
                                  disabled={itemActionProcessing === item.id + 'clear-hold'}
                                  onClick={() => promptItemReviewStatusChange(item.id, 'clear-hold', 'Reason for clearing this hold (optional):')}
                                  className="bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-black px-3.5 py-1.5 rounded-lg uppercase tracking-wider transition cursor-pointer disabled:opacity-50"
                                >
                                  {itemActionProcessing === item.id + 'clear-hold' ? '...' : 'Clear Hold'}
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    disabled={itemActionProcessing === item.id + 'flag-stolen'}
                                    onClick={() => promptItemReviewStatusChange(item.id, 'flag-stolen', 'Reason for flagging this item as suspected stolen (required, audit-logged):')}
                                    className="bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 text-[10px] font-black px-3.5 py-1.5 rounded-lg uppercase tracking-wider transition cursor-pointer disabled:opacity-50"
                                  >
                                    {itemActionProcessing === item.id + 'flag-stolen' ? '...' : 'Flag Suspected Stolen'}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={itemActionProcessing === item.id + 'legal-hold'}
                                    onClick={() => promptItemReviewStatusChange(item.id, 'legal-hold', 'Reason for placing this item under legal hold (required, audit-logged):')}
                                    className="bg-red-600 hover:bg-red-700 text-white text-[10px] font-black px-3.5 py-1.5 rounded-lg uppercase tracking-wider transition cursor-pointer disabled:opacity-50"
                                  >
                                    {itemActionProcessing === item.id + 'legal-hold' ? '...' : 'Place Legal Hold'}
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* TAB CONTENT 3: OPEN DISPUTES CHECKOUT */}
          {activeTab === 'disputes' && (
            <div className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-lg font-bold text-primary-green">{t.openDisputes}</h2>
                <p className="text-stone-500 text-xs">{t.disputeDesc}</p>
              </div>

              {dashboardData.disputes.length === 0 ? (
                <div className="bg-white border border-stone-100 rounded-2xl p-8 text-center text-stone-400 text-xs">
                  Immutable disputes logs are empty! No active owner conflicts found.
                </div>
              ) : (
                <div className="space-y-4">
                  {dashboardData.disputes.map((dispute: any) => (
                    <div key={dispute.id} className="bg-white border border-stone-100 rounded-3xl p-5 shadow-sm space-y-4">
                      <div className="flex justify-between items-center pb-3 border-b border-stone-100">
                        <div>
                          <span className="text-xs font-mono font-bold text-red-600">DISPUTE: {dispute.id}</span>
                          <p className="text-[10px] text-stone-400">Created on: {new Date(dispute.created_at).toLocaleDateString()}</p>
                        </div>
                        <span className="text-[10px] font-bold text-stone-500">Item: {dispute.item_id}</span>
                      </div>

                      {/* Side-by-side claim comparison info */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="border border-stone-200 rounded-2xl p-4 bg-brand-beige space-y-2">
                          <span className="text-[9px] font-extrabold text-stone-400 uppercase tracking-widest block">Claimant A (Original)</span>
                          <p className="text-xs font-bold text-primary-green leading-none">Phone: {dispute.original_claim_id}</p>
                          <div className="text-[10px] text-stone-500 mt-1 leading-tight space-y-1">
                            <span>Answer last 4: <b>Passed (4812)</b></span>
                            <span className="block">Details provided: "Lost my national ID Card at Kilimani."</span>
                          </div>
                        </div>

                        <div className="border border-stone-200 rounded-2xl p-4 bg-brand-beige space-y-2">
                          <span className="text-[9px] font-extrabold text-stone-400 uppercase tracking-widest block">Claimant B (Contesting)</span>
                          <p className="text-xs font-bold text-primary-green leading-none">Phone: {dispute.contesting_claim_id}</p>
                          <div className="text-[10px] text-stone-500 mt-1 leading-tight space-y-1">
                            <span>Answer last 4: <b>Passed (4812)</b></span>
                            <span className="block">Details provided: "National ID slid out of my handbag at Yaya Centre cyber cafe."</span>
                          </div>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex justify-end space-x-2 pt-2">
                        <button
                          onClick={() => handleResolveDispute(dispute.id, dispute.original_claim_id)}
                          disabled={adminActionProcessing}
                          className="bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold px-4 py-2 rounded-xl transition flex items-center justify-center space-x-1.5 disabled:opacity-50"
                        >
                          {adminActionProcessing ? (
                            <Loader2 className="animate-spin" size={12} />
                          ) : (
                            <span>Award Claimant A</span>
                          )}
                        </button>
                        <button
                          onClick={() => handleResolveDispute(dispute.id, dispute.contesting_claim_id)}
                          disabled={adminActionProcessing}
                          className="bg-accent-orange hover:bg-accent-hover text-white text-xs font-bold px-4 py-2 rounded-xl transition flex items-center justify-center space-x-1.5 disabled:opacity-50"
                        >
                          {adminActionProcessing ? (
                            <Loader2 className="animate-spin" size={12} />
                          ) : (
                            <span>Award Claimant B</span>
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB CONTENT 4: FINANCIAL IMMUTABLE LEDGER */}
          {activeTab === 'ledger' && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-primary-green">{t.ledgerTitle}</h2>

              {/* Pending Settlements — claims that have physically handed over
                  the item but whose real M-Pesa payout is still inside the
                  dispute window. Released automatically once settleAt passes,
                  or immediately here via admin override (audit-logged). */}
              <div className="bg-white border border-stone-100 rounded-3xl shadow-sm p-5 space-y-3">
                <div>
                  <h3 className="text-sm font-extrabold text-stone-800">Pending Settlements</h3>
                  <p className="text-[11px] text-stone-500">
                    Handover confirmed, payout booked, dispute window still open. Settles automatically, or release now to override.
                  </p>
                </div>
                {(!dashboardData.pendingSettlements || dashboardData.pendingSettlements.length === 0) ? (
                  <div className="text-center text-stone-400 text-xs py-4">No claims currently in the dispute window.</div>
                ) : (
                  <div className="space-y-2">
                    {dashboardData.pendingSettlements.map((ps: any) => {
                      const settleAtDate = ps.settleAt ? new Date(ps.settleAt) : null;
                      const isDue = settleAtDate ? settleAtDate.getTime() <= Date.now() : false;
                      return (
                        <div key={ps.claimId} className="flex flex-wrap items-center justify-between gap-2 border border-stone-100 rounded-xl p-3 bg-brand-beige/40">
                          <div className="text-xs">
                            <span className="font-mono font-bold text-stone-900">{ps.claimId}</span>
                            <span className="text-stone-400 mx-1.5">·</span>
                            <span className="text-stone-500">Item {ps.itemId}</span>
                            <span className="text-stone-400 mx-1.5">·</span>
                            <span className={`font-bold ${isDue ? 'text-emerald-600' : 'text-amber-600'}`}>
                              {settleAtDate ? (isDue ? 'Due now' : `Settles ${settleAtDate.toLocaleString()}`) : 'No settle time set'}
                            </span>
                            {ps.lockedTotalFee !== null && (
                              <span className="text-stone-400"> · KES {ps.lockedTotalFee}</span>
                            )}
                          </div>
                          <button
                            type="button"
                            disabled={itemActionProcessing === 'settlement:' + ps.claimId}
                            onClick={() => handleReleaseSettlementNow(ps.claimId)}
                            className="bg-stone-900 hover:bg-stone-800 text-white text-[10px] font-black px-3.5 py-1.5 rounded-lg uppercase tracking-wider transition cursor-pointer disabled:opacity-50"
                          >
                            {itemActionProcessing === 'settlement:' + ps.claimId ? '...' : 'Release Now'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="bg-white border border-stone-100 rounded-3xl shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-brand-beige text-[10px] font-extrabold text-stone-400 uppercase tracking-widest border-b border-stone-200">
                        <th className="px-5 py-3 font-bold">Transaction Reference</th>
                        <th className="px-5 py-3 font-bold">Type</th>
                        <th className="px-5 py-3 font-bold">Amount</th>
                        <th className="px-5 py-3 font-bold">Recipient / Target</th>
                        <th className="px-5 py-3 font-bold">Status</th>
                        <th className="px-5 py-3 font-bold">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100 text-xs text-stone-600 font-mono">
                      {dashboardData.ledger.map((entry: any) => (
                        <tr key={entry.id} className="hover:bg-brand-beige/50 transition">
                          <td className="px-5 py-3.5 font-bold text-stone-900">{entry.id}</td>
                          <td className="px-5 py-3.5">
                            <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase ${
                              entry.type === 'payment_received' ? 'bg-blue-50 text-blue-700' :
                              entry.type === 'finder_payout' ? 'bg-emerald-50 text-emerald-700' :
                              entry.type === 'agent_payout' ? 'bg-orange-50 text-orange-700' : 'bg-purple-50 text-purple-700'
                            }`}>
                              {entry.type.replace('_', ' ')}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 font-bold text-stone-900">KES {entry.amount}</td>
                          <td className="px-5 py-3.5">{entry.phone_or_till}</td>
                          <td className="px-5 py-3.5">
                            <span className={`font-bold ${entry.status === 'completed' ? 'text-emerald-600' : entry.status === 'failed' ? 'text-red-600' : 'text-amber-600'}`}>● {entry.status.toUpperCase()}</span>
                          </td>
                          <td className="px-5 py-3.5 text-stone-400 text-[11px] whitespace-nowrap">
                            {entry.created_at ? new Date(entry.created_at).toLocaleString() : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB CONTENT 5: MANUAL REVIEW QUEUE */}
          {activeTab === 'review' && (
            <div className="space-y-6">
              <div className="space-y-1">
                <h2 className="text-lg font-bold text-primary-green">Flagged for Manual Review</h2>
                <p className="text-stone-500 text-xs">These items have low OCR confidence, missing details, or require administrator correction.</p>
              </div>

              {selectedReviewItem ? (
                <div className="bg-white border border-stone-200 rounded-3xl p-6 md:p-8 shadow-md space-y-6 max-w-2xl mx-auto">
                  <div className="flex justify-between items-center border-b border-stone-100 pb-3">
                    <h3 className="font-extrabold text-stone-900">Reviewing Item: {selectedReviewItem.id}</h3>
                    <button
                      onClick={() => setSelectedReviewItem(null)}
                      className="text-stone-400 hover:text-stone-600 text-xs font-bold"
                    >
                      Back to list
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Left: Finder Photo */}
                    <div className="space-y-2">
                      <span className="text-[10px] font-extrabold text-stone-400 uppercase tracking-widest block">Uploaded Photo</span>
                      <div className="border border-stone-100 rounded-2xl overflow-hidden bg-stone-50 aspect-[4/3] flex items-center justify-center">
                        <img
                          src={selectedReviewItem.photo_url}
                          alt="Document to review"
                          className="w-full h-full object-contain animate-fade-in"
                          referrerPolicy="no-referrer"
                        />
                      </div>
                    </div>

                    {/* Right: Correction Form */}
                    <form onSubmit={handleSaveReview} className="space-y-4">
                      <div className="space-y-1">
                        <label htmlFor="review-category" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">Item Category</label>
                        <select
                          id="review-category"
                          value={reviewCategoryId}
                          onChange={(e) => setReviewCategoryId(e.target.value)}
                          className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs font-semibold bg-white disabled:bg-stone-50 disabled:text-stone-400"
                          disabled={categoriesLoading}
                        >
                          {categoriesLoading ? (
                            <option value="">Loading categories...</option>
                          ) : (
                            (() => {
                              const validCategories = categories.filter(cat => cat.name_en && cat.name_sw);
                              const invalidCount = categories.length - validCategories.length;
                              if (invalidCount > 0) {
                                console.warn(`[AdminView] Filtered out ${invalidCount} incomplete categories from rendering.`);
                              }
                              return validCategories.map(cat => (
                                <option key={cat.id} value={cat.id}>
                                  {cat.name_en}
                                </option>
                              ));
                            })()
                          )}
                        </select>
                      </div>

                      {/* Reassign Agent Dropdown */}
                      <div className="space-y-1">
                        <label htmlFor="review-assigned-agent" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">Assigned Agent Hub</label>
                        <select
                          id="review-assigned-agent"
                          value={reviewAssignedAgentId}
                          onChange={(e) => setReviewAssignedAgentId(e.target.value)}
                          className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs font-semibold bg-white"
                        >
                          <option value="">-- Select Agent Hub --</option>
                          {dashboardData.agents && dashboardData.agents
                            .filter((agent: any) => agent.status === 'active')
                            .map((agent: any) => (
                              <option key={agent.id} value={agent.id}>
                                {agent.business_name} ({agent.location_address})
                              </option>
                            ))
                          }
                        </select>
                      </div>

                      {/* Assignment Metadata Info */}
                      {selectedReviewItem.agent_assignment_method && (
                        <div className="p-2.5 bg-stone-50 border border-stone-100 rounded-xl text-[10px] font-mono text-stone-600 space-y-1">
                          <p className="font-sans font-bold text-stone-700">Assignment Metadata:</p>
                          <p>Method: <span className="font-bold text-stone-900">{selectedReviewItem.agent_assignment_method}</span></p>
                          {selectedReviewItem.agent_assignment_distance_km !== null && (
                            <p>Calculated Distance: <span className="font-bold text-stone-900">{parseFloat(selectedReviewItem.agent_assignment_distance_km).toFixed(2)} km</span></p>
                          )}
                          {selectedReviewItem.needs_manual_agent_reassignment ? (
                            <p className="text-red-600 font-sans font-extrabold uppercase animate-pulse">⚠️ Reassigned to Default Backup Agent (Needs Manual Correction)</p>
                          ) : (
                            <p className="text-emerald-600 font-sans font-extrabold uppercase">✓ Successfully Auto-Assigned</p>
                          )}
                        </div>
                      )}

                      <div className="flex items-center space-x-2 py-1">
                        <input
                          type="checkbox"
                          id="reviewIsDescriptionOnly"
                          checked={reviewIsDescriptionOnly}
                          onChange={(e) => setReviewIsDescriptionOnly(e.target.checked)}
                          className="rounded text-primary-green focus:ring-primary-green h-4 w-4"
                        />
                        <label htmlFor="reviewIsDescriptionOnly" className="text-xs font-bold text-stone-700">
                          Mark as Description-Only Item (e.g. keys, bags)
                        </label>
                      </div>

                      {reviewIsDescriptionOnly ? (
                        <div className="space-y-1">
                          <label htmlFor="review-description" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">Free-text Description</label>
                          <textarea
                            id="review-description"
                            value={reviewDescription}
                            onChange={(e) => setReviewDescription(e.target.value)}
                            placeholder="Write a clear, searchable description of the item (e.g. 'Key ring with a black fob and 3 keys')"
                            className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs h-24"
                            required
                          />
                        </div>
                      ) : (
                        <>
                          <div className="space-y-1">
                            <label htmlFor="review-ocr-number" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">Document / ID Number</label>
                            <input
                              id="review-ocr-number"
                              type="text"
                              value={reviewOcrNumber}
                              onChange={(e) => setReviewOcrNumber(e.target.value)}
                              placeholder="e.g. 3841920"
                              className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-xs font-semibold"
                              required
                            />
                            <p className="text-[10px] text-stone-400 font-medium">Original OCR: {selectedReviewItem.ocr_extracted_number || 'None'}</p>
                          </div>

                          <div className="space-y-1">
                            <label htmlFor="review-ocr-name" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">Full Name on Document</label>
                            <input
                              id="review-ocr-name"
                              type="text"
                              value={reviewOcrName}
                              onChange={(e) => setReviewOcrName(e.target.value)}
                              placeholder="e.g. JOHN DOE"
                              className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-xs font-semibold uppercase"
                              required
                            />
                            <p className="text-[10px] text-stone-400 font-medium">Original OCR: {selectedReviewItem.ocr_extracted_name || 'None'}</p>
                          </div>
                        </>
                      )}

                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={reviewSaving}
                          className="flex-1 bg-stone-900 hover:bg-stone-800 text-white py-3 rounded-xl font-bold text-xs transition flex items-center justify-center space-x-2 cursor-pointer"
                        >
                          {reviewSaving ? (
                            <Loader2 className="animate-spin" size={16} />
                          ) : (
                            <>
                              <span>Save Correction</span>
                              <ArrowRight size={16} />
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          disabled={reviewSaving}
                          onClick={() => handleRejectAsSpam(selectedReviewItem.id)}
                          className="bg-red-600 hover:bg-red-700 text-white px-4 py-3 rounded-xl font-bold text-xs transition cursor-pointer"
                        >
                          Reject as Spam
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {dashboardData.items.filter((item: any) => item.flaggedForReview).length === 0 ? (
                    <div className="bg-white border border-stone-100 rounded-2xl p-8 text-center text-stone-400 text-xs">
                      All reported items have been reviewed! Review queue is empty.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {dashboardData.items
                        .filter((item: any) => item.flaggedForReview)
                        .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
                        .map((item: any) => (
                          <div key={item.id} className="bg-white border border-stone-100 rounded-2xl p-5 shadow-sm flex flex-col justify-between gap-4">
                            <div className="flex gap-4">
                              <div className="w-16 h-16 rounded-xl bg-stone-50 border border-stone-100 overflow-hidden shrink-0 flex items-center justify-center">
                                <img
                                  src={item.photo_url}
                                  alt="Thumbnail"
                                  className="w-full h-full object-contain"
                                  referrerPolicy="no-referrer"
                                />
                              </div>
                              <div className="space-y-1">
                                <span className="bg-red-50 text-red-600 text-[9px] font-black px-2 py-0.5 rounded-full uppercase">Flagged</span>
                                <h3 className="font-extrabold text-stone-900 text-xs">Code: {item.id}</h3>
                                <p className="text-stone-500 text-[10px] leading-snug">{item.location_description}</p>
                                <p className="text-stone-400 text-[9px] font-mono">Date: {new Date(item.created_at).toLocaleDateString()}</p>
                                {item.agent_assignment_method && (
                                  <div className="mt-1.5 p-1.5 bg-stone-50 rounded-lg text-[9px] font-mono text-stone-600">
                                    <p>Assignment: <span className="font-bold">{item.agent_assignment_method}</span></p>
                                    {item.agent_assignment_distance_km !== null && (
                                      <p>Distance: <span className="font-bold">{parseFloat(item.agent_assignment_distance_km).toFixed(2)} km</span></p>
                                    )}
                                    {item.needs_manual_agent_reassignment && (
                                      <p className="text-red-600 font-bold uppercase animate-pulse">⚠️ Needs Manual Reassignment</p>
                                    )}
                                  </div>
                                )}
                                {item.reputation && (
                                  <div className="mt-1.5 space-y-1">
                                    <p className="text-[10px] text-stone-700 font-bold">
                                      Finder: {item.finder_phone}
                                    </p>
                                    <p className="text-[9px] text-stone-500">
                                      Reputation: {item.reputation.rejected_reports} rejected / {item.reputation.total_reports} total
                                    </p>
                                    {item.reputation.autoFlag && (
                                      <div className="flex flex-col gap-1 mt-1">
                                        <span className="bg-red-100 text-red-800 text-[9px] font-black px-2 py-0.5 rounded-full inline-block uppercase text-center w-fit">
                                          ⚠️ Poor Reputation Block
                                        </span>
                                        <button
                                          type="button"
                                          disabled={adminActionProcessing}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleClearReputation(item.finder_phone);
                                          }}
                                          className="text-[9px] text-primary-green hover:underline font-bold text-left cursor-pointer disabled:opacity-50 flex items-center space-x-1"
                                        >
                                          {adminActionProcessing ? (
                                            <Loader2 className="animate-spin" size={10} />
                                          ) : (
                                            <span>Clear Reputation Block</span>
                                          )}
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                            <button
                              onClick={() => startReview(item)}
                              className="w-full bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold py-2 rounded-xl transition cursor-pointer"
                            >
                              Review Item details
                            </button>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB CONTENT 6: CATEGORIES & PRICING MANAGEMENT */}
          {activeTab === 'categories' && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-stone-100 pb-4">
                <div className="space-y-1">
                  <h2 className="text-lg font-bold text-primary-green">Kategoria na Bei / Categories & Pricing</h2>
                  <p className="text-stone-500 text-xs">Dhibiti kategoria za bidhaa, bei, na migao ya malipo. / Manage document categories, fees, and disbursement splits.</p>
                </div>
                {!showCategoryForm && (
                  <button
                    onClick={() => resetCategoryForm('create')}
                    className="bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition cursor-pointer flex items-center space-x-1"
                  >
                    <span>+ Add New Category (Weka Kategoria Mpya)</span>
                  </button>
                )}
              </div>

              {showCategoryForm ? (
                <div className="bg-white border border-stone-200 rounded-3xl p-6 md:p-8 shadow-md space-y-6 max-w-2xl mx-auto">
                  <div className="flex justify-between items-center border-b border-stone-100 pb-3">
                    <h3 className="font-extrabold text-stone-900">
                      {showCategoryForm === 'create' ? 'Create New Category' : `Editing Category: ${catFormId}`}
                    </h3>
                    <button
                      onClick={() => setShowCategoryForm(null)}
                      className="text-stone-400 hover:text-stone-600 text-xs font-bold"
                    >
                      Cancel / Ghairi
                    </button>
                  </div>

                  <form onSubmit={handleSaveCategory} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* ID (only editable in create mode) */}
                      <div className="space-y-1">
                        <label htmlFor="cat-form-id" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                          ID / Msimbo (lowercase-kebab-case)
                        </label>
                        <input
                          id="cat-form-id"
                          type="text"
                          value={catFormId}
                          onChange={(e) => setCatFormId(e.target.value)}
                          placeholder="e.g. driving-license"
                          className="w-full border border-stone-200 rounded-xl px-3 py-2 text-xs font-semibold bg-white disabled:bg-stone-50 disabled:text-stone-400 font-mono"
                          disabled={showCategoryForm === 'edit'}
                          required
                        />
                        {showCategoryForm === 'create' && (
                          <p className="text-[10px] text-stone-400 font-medium">Must be unique, letters, numbers and hyphens only.</p>
                        )}
                      </div>

                      {/* Is Sensitive Document */}
                      <div className="space-y-1 flex flex-col justify-end pb-2">
                        <div className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id="catFormIsSensitive"
                            checked={catFormIsSensitive}
                            onChange={(e) => setCatFormIsSensitive(e.target.checked)}
                            className="rounded text-primary-green focus:ring-primary-green h-4 w-4"
                          />
                          <label htmlFor="catFormIsSensitive" className="text-xs font-bold text-stone-700">
                            Is Sensitive Document? (Inahitaji OCR/ID ya mmliki)
                          </label>
                        </div>
                      </div>

                      {/* Elevated Review (cash, children's-property style categories) */}
                      <div className="space-y-1 flex flex-col justify-end pb-2">
                        <div className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id="catFormElevatedReview"
                            checked={catFormElevatedReview}
                            onChange={(e) => setCatFormElevatedReview(e.target.checked)}
                            className="rounded text-red-600 focus:ring-red-500 h-4 w-4"
                          />
                          <label htmlFor="catFormElevatedReview" className="text-xs font-bold text-stone-700">
                            Elevated Review — force admin approval before this category's items go public
                          </label>
                        </div>
                      </div>

                      {/* Flat fee override toggle — decides whether total_fee/finder_share/
                          agent_share/platform_share below win outright (ignoring the Recovery
                          Fee Engine section further down), or whether the engine computes the
                          fee fresh from base/complexity/delay/ceiling every time. Previously
                          this was silently forced on by every save from this form, which meant
                          editing the engine fields below had no effect the moment you saved —
                          it's now an explicit choice. */}
                      <div className="col-span-3 space-y-1">
                        <div className="flex items-center space-x-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          <input
                            type="checkbox"
                            id="catFormIsAdminModified"
                            checked={catFormIsAdminModified}
                            onChange={(e) => setCatFormIsAdminModified(e.target.checked)}
                            className="rounded text-amber-600 focus:ring-amber-500 h-4 w-4"
                          />
                          <label htmlFor="catFormIsAdminModified" className="text-xs font-bold text-amber-800">
                            Use flat fee override — pin Total/Finder/Agent/Platform fee below exactly, and ignore the Recovery Fee Engine config further down entirely
                          </label>
                        </div>
                      </div>

                      {/* Name EN */}
                      <div className="space-y-1">
                        <label htmlFor="cat-form-name-en" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                          Name (English) / Jina la Kiingereza
                        </label>
                        <input
                          id="cat-form-name-en"
                          type="text"
                          value={catFormNameEn}
                          onChange={(e) => setCatFormNameEn(e.target.value)}
                          placeholder="e.g. Driving License"
                          className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-xs font-semibold"
                          required
                        />
                      </div>

                      {/* Name SW */}
                      <div className="space-y-1">
                        <label htmlFor="cat-form-name-sw" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                          Name (Swahili) / Jina la Kiswahili
                        </label>
                        <input
                          id="cat-form-name-sw"
                          type="text"
                          value={catFormNameSw}
                          onChange={(e) => setCatFormNameSw(e.target.value)}
                          placeholder="e.g. Leseni ya Udereva"
                          className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-xs font-semibold"
                          required
                        />
                      </div>

                      {/* Total Fee */}
                      <div className="space-y-1">
                        <label htmlFor="cat-form-total-fee" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                          Total Fee (KES) / Ada ya Jumla
                        </label>
                        <input
                          id="cat-form-total-fee"
                          type="number"
                          step="0.01"
                          min="0"
                          value={catFormTotalFee}
                          onChange={(e) => setCatFormTotalFee(parseFloat(e.target.value) || 0)}
                          className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-xs font-semibold"
                          required
                        />
                      </div>

                      {/* Finder Share */}
                      <div className="space-y-1">
                        <label htmlFor="cat-form-finder-share" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                          Finder Reward (KES) / Mgao wa Aliyepata
                        </label>
                        <input
                          id="cat-form-finder-share"
                          type="number"
                          step="0.01"
                          min="0"
                          value={catFormFinderShare}
                          onChange={(e) => setCatFormFinderShare(parseFloat(e.target.value) || 0)}
                          className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-xs font-semibold"
                          required
                        />
                      </div>

                      {/* Agent Share */}
                      <div className="space-y-1">
                        <label htmlFor="cat-form-agent-share" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                          Agent Commission (KES) / Mgao wa Wakala
                        </label>
                        <input
                          id="cat-form-agent-share"
                          type="number"
                          step="0.01"
                          min="0"
                          value={catFormAgentShare}
                          onChange={(e) => setCatFormAgentShare(parseFloat(e.target.value) || 0)}
                          className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-xs font-semibold"
                          required
                        />
                      </div>

                      {/* Platform Share */}
                      <div className="space-y-1">
                        <label htmlFor="cat-form-platform-share" className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                          Platform Fee (KES) / Mgao wa Return4me
                        </label>
                        <input
                          id="cat-form-platform-share"
                          type="number"
                          step="0.01"
                          min="0"
                          value={catFormPlatformShare}
                          onChange={(e) => setCatFormPlatformShare(parseFloat(e.target.value) || 0)}
                          className="w-full border border-stone-200 rounded-xl px-3 py-2.5 text-xs font-semibold"
                          required
                        />
                      </div>
                    </div>

                    {/* Math verification helper */}
                    {(() => {
                      const totalSum = parseFloat((Number(catFormFinderShare) + Number(catFormAgentShare) + Number(catFormPlatformShare)).toFixed(2));
                      const difference = parseFloat((catFormTotalFee - totalSum).toFixed(2));
                      const isMatch = totalSum === parseFloat(Number(catFormTotalFee).toFixed(2));
                      return (
                        <div className={`p-3.5 rounded-xl text-xs font-bold ${isMatch ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
                          <div className="flex justify-between items-center">
                            <span>Splits Sum / Jumla ya Mgao: KES {totalSum}</span>
                            <span>Target / Lengo: KES {catFormTotalFee}</span>
                          </div>
                          <div className="text-[10px] mt-1 font-semibold">
                            {isMatch ? (
                              <span className="flex items-center space-x-1">
                                <span>✅ Perfect match! Payout split equations balance successfully.</span>
                              </span>
                            ) : (
                              <span>
                                ⚠️ Discrepancy: Difference of KES {difference}. Split sum (Finder + Agent + Platform) must sum to the Total Fee exactly.
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Recovery Fee Engine config — see src/services/feeEngine.ts.
                        Ignored by the engine whenever this category has a flat
                        admin-set total_fee/finder_share/etc. above (is_admin_modified);
                        that flat override always wins. Otherwise the finder/agent/
                        platform shares above are just a preview of what the engine
                        would compute with no declared value — the real fee for an
                        item is computed fresh at report time from these inputs. */}
                    <div className={`border rounded-xl p-4 space-y-3 ${catFormIsAdminModified ? 'border-stone-200 bg-stone-100 opacity-60' : 'border-stone-200 bg-stone-50'}`}>
                      <p className="text-[11px] font-extrabold text-stone-700 uppercase tracking-wider">
                        Recovery Fee Engine Config
                      </p>
                      {catFormIsAdminModified && (
                        <p className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                          Inactive — "Use flat fee override" is checked above, so this category ignores everything below and uses the flat Total/Finder/Agent/Platform fee instead.
                        </p>
                      )}
                      <p className="text-[10px] text-stone-500 leading-tight">
                        rawFee = Base + Complexity + Delay. If a finder gives a declared value, the fee is capped at Ceiling % of that value (never raised above rawFee). Split % applies to the resulting fee, not the item's value.
                      </p>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="space-y-1">
                          <label htmlFor="cat-form-base-fee" className="block text-[10px] font-bold text-stone-600 uppercase">Base Fee (KES)</label>
                          <input id="cat-form-base-fee" type="number" step="0.01" min="0" value={catFormBaseFee}
                            onChange={(e) => setCatFormBaseFee(parseFloat(e.target.value) || 0)}
                            className="w-full border border-stone-200 rounded-lg px-2 py-2 text-xs font-semibold" />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="cat-form-complexity-fee" className="block text-[10px] font-bold text-stone-600 uppercase">Complexity Fee (KES)</label>
                          <input id="cat-form-complexity-fee" type="number" step="0.01" min="0" value={catFormComplexityFee}
                            onChange={(e) => setCatFormComplexityFee(parseFloat(e.target.value) || 0)}
                            className="w-full border border-stone-200 rounded-lg px-2 py-2 text-xs font-semibold" />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="cat-form-delay-fee" className="block text-[10px] font-bold text-stone-600 uppercase">Delay Fee (KES)</label>
                          <input id="cat-form-delay-fee" type="number" step="0.01" min="0" value={catFormDelayFee}
                            onChange={(e) => setCatFormDelayFee(parseFloat(e.target.value) || 0)}
                            className="w-full border border-stone-200 rounded-lg px-2 py-2 text-xs font-semibold" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <label htmlFor="cat-form-ceiling-pct" className="block text-[10px] font-bold text-stone-600 uppercase">Ceiling % of Declared Value</label>
                          <input id="cat-form-ceiling-pct" type="number" step="0.5" min="0" max="100" value={catFormCeilingPercent}
                            onChange={(e) => setCatFormCeilingPercent(parseFloat(e.target.value) || 0)}
                            className="w-full border border-stone-200 rounded-lg px-2 py-2 text-xs font-semibold" />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="cat-form-finder-cap" className="block text-[10px] font-bold text-stone-600 uppercase">Finder Reward Cap (KES, optional)</label>
                          <input id="cat-form-finder-cap" type="number" step="0.01" min="0" value={catFormFinderRewardCap}
                            onChange={(e) => setCatFormFinderRewardCap(e.target.value)}
                            placeholder="No cap"
                            className="w-full border border-stone-200 rounded-lg px-2 py-2 text-xs font-semibold" />
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="space-y-1">
                          <label htmlFor="cat-form-finder-pct" className="block text-[10px] font-bold text-stone-600 uppercase">Finder %</label>
                          <input id="cat-form-finder-pct" type="number" step="0.5" min="0" max="100" value={catFormFinderPct}
                            onChange={(e) => setCatFormFinderPct(parseFloat(e.target.value) || 0)}
                            className="w-full border border-stone-200 rounded-lg px-2 py-2 text-xs font-semibold" />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="cat-form-agent-pct" className="block text-[10px] font-bold text-stone-600 uppercase">Agent %</label>
                          <input id="cat-form-agent-pct" type="number" step="0.5" min="0" max="100" value={catFormAgentPct}
                            onChange={(e) => setCatFormAgentPct(parseFloat(e.target.value) || 0)}
                            className="w-full border border-stone-200 rounded-lg px-2 py-2 text-xs font-semibold" />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="cat-form-platform-pct" className="block text-[10px] font-bold text-stone-600 uppercase">Platform %</label>
                          <input id="cat-form-platform-pct" type="number" step="0.5" min="0" max="100" value={catFormPlatformPct}
                            onChange={(e) => setCatFormPlatformPct(parseFloat(e.target.value) || 0)}
                            className="w-full border border-stone-200 rounded-lg px-2 py-2 text-xs font-semibold" />
                        </div>
                      </div>
                      {parseFloat((Number(catFormFinderPct) + Number(catFormAgentPct) + Number(catFormPlatformPct)).toFixed(2)) !== 100 && (
                        <p className="text-[10px] font-bold text-red-700">
                          ⚠️ Finder % + Agent % + Platform % = {(Number(catFormFinderPct) + Number(catFormAgentPct) + Number(catFormPlatformPct)).toFixed(2)}%, not 100%. The platform share absorbs the difference at settlement time, but percentages should sum to 100 for clarity.
                        </p>
                      )}
                    </div>

                    <div className="flex gap-2 pt-2">
                      <button
                        type="submit"
                        disabled={catSaving || !splitsMatch}
                        className="flex-1 bg-stone-900 hover:bg-stone-800 text-white py-3 rounded-xl font-bold text-xs transition flex items-center justify-center space-x-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {catSaving ? (
                          <Loader2 className="animate-spin" size={16} />
                        ) : (
                          <>
                            <span>Save Category / Hifadhi</span>
                            <ArrowRight size={16} />
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowCategoryForm(null)}
                        className="bg-stone-100 hover:bg-stone-200 text-stone-700 px-4 py-3 rounded-xl font-bold text-xs transition cursor-pointer"
                      >
                        Cancel / Ghairi
                      </button>
                    </div>
                  </form>
                </div>
              ) : (
                <div className="bg-white border border-stone-100 rounded-3xl overflow-hidden shadow-sm">
                  {adminCategoriesLoading ? (
                    <div className="flex flex-col items-center justify-center py-12 space-y-2">
                      <Loader2 className="animate-spin text-primary-green w-6 h-6" />
                      <p className="text-stone-400 text-[10px] font-bold uppercase tracking-wider font-semibold">Loading categories...</p>
                    </div>
                  ) : adminCategories.length === 0 ? (
                    <div className="p-12 text-center text-stone-400 text-xs font-semibold">
                      No categories found on the server.
                    </div>
                  ) : (
                    <div className="overflow-x-auto font-sans">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-stone-50 border-b border-stone-100 text-stone-400 uppercase tracking-wider font-extrabold text-[10px]">
                            <th className="py-3.5 px-4 font-bold">ID</th>
                            <th className="py-3.5 px-4 font-bold">Name (English / Kiswahili)</th>
                            <th className="py-3.5 px-4 text-right font-bold">Total Fee</th>
                            <th className="py-3.5 px-4 text-right font-bold">Finder Share</th>
                            <th className="py-3.5 px-4 text-right font-bold">Agent Share</th>
                            <th className="py-3.5 px-4 text-right font-bold">Platform Share</th>
                            <th className="py-3.5 px-4 text-center font-bold">Sensitive</th>
                            <th className="py-3.5 px-4 text-center font-bold">Items Count</th>
                            <th className="py-3.5 px-4 text-center font-bold">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100 font-sans">
                          {adminCategories.map((cat) => (
                            <tr key={cat.id} className="hover:bg-stone-50 transition">
                              <td className="py-3 px-4 font-mono font-bold text-stone-900">{cat.id}</td>
                              <td className="py-3 px-4">
                                <div className="flex items-center space-x-2">
                                  <p className="font-extrabold text-stone-900">{cat.name_en}</p>
                                  {cat.is_admin_modified && (
                                    <span className="bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded border border-amber-200 text-[9px] font-extrabold uppercase">
                                      Customized
                                    </span>
                                  )}
                                </div>
                                <p className="text-stone-400 text-[10px]">{cat.name_sw}</p>
                              </td>
                              <td className="py-3 px-4 text-right font-bold text-stone-900">KES {cat.total_fee}</td>
                              <td className="py-3 px-4 text-right text-stone-600">KES {cat.finder_share}</td>
                              <td className="py-3 px-4 text-right text-stone-600">KES {cat.agent_share}</td>
                              <td className="py-3 px-4 text-right text-stone-600">KES {cat.platform_share}</td>
                              <td className="py-3 px-4 text-center">
                                {cat.is_sensitive_document ? (
                                  <span className="bg-red-50 text-red-700 px-2 py-0.5 rounded-full text-[9px] font-extrabold uppercase">Yes</span>
                                ) : (
                                  <span className="bg-stone-100 text-stone-500 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase">No</span>
                                )}
                              </td>
                              <td className="py-3 px-4 text-center font-bold">
                                <span className={`px-2.5 py-0.5 rounded-full text-[10px] ${cat.item_count > 0 ? 'bg-emerald-50 text-emerald-700 font-bold' : 'bg-stone-100 text-stone-400'}`}>
                                  {cat.item_count} items
                                </span>
                              </td>
                              <td className="py-3 px-4 text-center space-x-1.5 whitespace-nowrap">
                                <button
                                  onClick={() => resetCategoryForm('edit', cat)}
                                  className="text-[10px] font-bold text-stone-900 hover:underline cursor-pointer"
                                >
                                  Edit / Hariri
                                </button>
                                <span className="text-stone-200">|</span>
                                <button
                                  disabled={cat.item_count > 0}
                                  onClick={() => handleDeleteCategory(cat.id, cat.name_en)}
                                  className={`text-[10px] font-bold cursor-pointer ${cat.item_count > 0 ? 'text-stone-300 cursor-not-allowed' : 'text-red-600 hover:underline'}`}
                                  title={cat.item_count > 0 ? `Cannot delete category because ${cat.item_count} item(s) are currently categorized under it.` : 'Delete Category'}
                                >
                                  Delete / Futa
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'strikes' && (
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <h2 className="text-xl font-extrabold text-stone-900">User Payment Strikes</h2>
                  <p className="text-stone-500 text-xs mt-0.5">Manage users who failed to pay within the 15-minute viewing verification window.</p>
                </div>
                <button
                  onClick={fetchPaymentStrikes}
                  disabled={paymentStrikesLoading}
                  className="bg-stone-900 hover:bg-stone-800 text-white font-extrabold px-4 py-2 rounded-xl text-xs flex items-center space-x-1.5 transition cursor-pointer disabled:opacity-50 animate-fade-in"
                >
                  {paymentStrikesLoading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
                  <span>Reload list</span>
                </button>
              </div>

              <div className="bg-white border border-stone-100 rounded-3xl overflow-hidden shadow-sm">
                {paymentStrikesLoading ? (
                  <div className="flex flex-col items-center justify-center py-12 space-y-2">
                    <Loader2 className="animate-spin text-primary-green w-6 h-6" />
                    <p className="text-stone-400 text-[10px] font-bold uppercase tracking-wider font-semibold">Loading strikes...</p>
                  </div>
                ) : paymentStrikes.length === 0 ? (
                  <div className="p-12 text-center text-stone-400 text-xs font-semibold">
                    No active payment strikes recorded on the platform.
                  </div>
                ) : (
                  <div className="overflow-x-auto font-sans">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-stone-50 border-b border-stone-100 text-stone-400 uppercase tracking-wider font-extrabold text-[10px]">
                          <th className="py-3.5 px-4 font-bold">User Phone Number</th>
                          <th className="py-3.5 px-4 text-center font-bold">Active Strikes Count</th>
                          <th className="py-3.5 px-4 text-center font-bold">Status Limit</th>
                          <th className="py-3.5 px-4 text-center font-bold">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-100 font-sans">
                        {paymentStrikes.map((strike) => (
                          <tr key={strike.phone} className="hover:bg-stone-50 transition">
                            <td className="py-3.5 px-4 font-mono font-bold text-stone-900">{strike.phone}</td>
                            <td className="py-3.5 px-4 text-center">
                              <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${
                                strike.count >= 3 ? 'bg-red-100 text-red-800' :
                                strike.count >= 2 ? 'bg-orange-100 text-orange-800' :
                                'bg-amber-100 text-amber-800'
                              }`}>
                                {strike.count} Strike(s)
                              </span>
                            </td>
                            <td className="py-3.5 px-4 text-center">
                              {strike.count >= 3 ? (
                                <span className="bg-red-50 text-red-700 px-2 py-0.5 rounded border border-red-200 text-[9px] font-extrabold uppercase">
                                  Blocked from claims
                                </span>
                              ) : strike.count > 0 ? (
                                <span className="bg-amber-50 text-amber-700 px-2 py-0.5 rounded border border-amber-200 text-[9px] font-extrabold uppercase">
                                  Warning active
                                </span>
                              ) : (
                                <span className="bg-stone-100 text-stone-500 px-2 py-0.5 rounded border border-stone-200 text-[9px] font-bold uppercase">
                                  Clear
                                </span>
                              )}
                            </td>
                            <td className="py-3.5 px-4 text-center whitespace-nowrap">
                              <button
                                onClick={() => handleClearStrikes(strike.phone)}
                                disabled={adminActionProcessing}
                                className="bg-emerald-500 hover:bg-emerald-600 text-white font-extrabold px-3 py-1.5 rounded-lg text-[10px] transition cursor-pointer flex items-center justify-center space-x-1.5 mx-auto disabled:opacity-50"
                              >
                                {adminActionProcessing ? (
                                  <Loader2 className="animate-spin" size={10} />
                                ) : (
                                  <span>Clear Strikes</span>
                                )}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      )}

      {/* Custom Confirmation Modal */}
      {confirmModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-stone-900/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-white border border-stone-200 rounded-3xl p-6 shadow-xl max-w-sm w-full space-y-4 animate-scale-up">
            <div className="flex items-start space-x-3 text-amber-600">
              <ShieldAlert className="w-6 h-6 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h3 className="font-extrabold text-sm text-stone-900 uppercase tracking-wider">
                  {confirmModal.title}
                </h3>
                <p className="text-stone-500 text-xs leading-relaxed font-semibold">
                  {confirmModal.message}
                </p>
              </div>
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => setConfirmModal(null)}
                className="bg-stone-100 hover:bg-stone-200 text-stone-600 text-xs font-bold px-4 py-2 rounded-xl transition"
              >
                {lang === 'en' ? 'Cancel' : 'Ghairi'}
              </button>
              <button
                onClick={() => {
                  confirmModal.onConfirm();
                  setConfirmModal(null);
                }}
                className="bg-primary-green hover:bg-primary-hover text-white text-xs font-bold px-4 py-2 rounded-xl transition"
              >
                {lang === 'en' ? 'Confirm' : 'Thibitisha'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox Image Zoom Portal */}
      {lightboxImage && (
        <div 
          onClick={() => setLightboxImage(null)}
          className="fixed inset-0 z-[120] bg-black/90 flex items-center justify-center p-4 cursor-zoom-out animate-fade-in"
          role="dialog"
          aria-modal="true"
          aria-label="Zoomed photograph"
          tabIndex={-1}
          ref={lightboxCloseRef}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setLightboxImage(null);
            }
          }}
        >
          <div className="relative max-w-4xl max-h-[90vh] w-full h-full flex flex-col items-center justify-center">
            <img
              src={lightboxImage}
              alt="Zoomed Photograph"
              className="max-w-full max-h-[80vh] object-contain rounded-2xl"
              referrerPolicy="no-referrer"
            />
            <p className="text-stone-400 text-xs mt-4 font-bold bg-stone-900 px-4 py-2 rounded-full uppercase tracking-wider">
              Click anywhere, or press Escape, to close full screen view
            </p>
          </div>
        </div>
      )}

    </div>
  );
}
