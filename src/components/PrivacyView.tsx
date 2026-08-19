import React, { useState } from 'react';
import { ShieldCheck, Lock, Eye, Mail, Award, Globe, HelpCircle, FileText, HelpCircle as InfoIcon, Trash2, ShieldAlert } from 'lucide-react';

interface PrivacyViewProps {
  lang: 'en' | 'sw';
  setView: (view: any) => void;
}

export default function PrivacyView({ lang, setView }: PrivacyViewProps) {
  const [showErasureForm, setShowErasureForm] = useState(false);
  const [phone, setPhone] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone) {
      setError(lang === 'en' ? 'Please enter your phone number' : 'Tafadhali ingiza nambari yako ya simu');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/request-otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || (lang === 'en' ? 'Failed to send OTP code' : 'Imeshindwa kutuma msimbo wa OTP'));
      }
      setOtpSent(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyAndDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpCode) {
      setError(lang === 'en' ? 'Please enter the OTP verification code' : 'Tafadhali ingiza msimbo wa uhakiki wa OTP');
      return;
    }
    if (!consentChecked) {
      setError(lang === 'en' ? 'You must check the consent box to proceed' : 'Ni lazima ukubali idhini ili kuendelea');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/request-data-deletion', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone,
          code: otpCode,
          confirmConsent: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || (lang === 'en' ? 'Verification or deletion failed' : 'Uhakiki au ufutaji umeshindwa'));
      }
      setSuccessMessage(data.message || (lang === 'en' ? 'Data successfully erased.' : 'Data imefutwa kikamilifu.'));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setPhone('');
    setOtpSent(false);
    setOtpCode('');
    setConsentChecked(false);
    setError('');
    setSuccessMessage('');
    setShowErasureForm(false);
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-12 space-y-12 fade-in">
      {/* Header */}
      <div className="border-b border-brand-border pb-8 text-center sm:text-left">
        <span className="inline-flex items-center space-x-1 bg-emerald-50 text-primary-green border border-emerald-100 font-extrabold px-3 py-1 rounded-full text-xs uppercase mb-4">
          <ShieldCheck size={12} />
          <span>Kenya ODPC Compliance Standards</span>
        </span>
        <h1 className="text-4xl font-extrabold text-primary-green tracking-tight">
          {lang === 'en' ? 'Privacy Policy' : 'Sera ya Faragha'}
        </h1>
        <p className="text-stone-500 text-sm mt-2 font-mono">
          {lang === 'en' ? 'Last Updated: July 2026' : 'Imesasishwa Mwisho: Julai 2026'} | Jamoko Solutions Ltd · CR No. [PENDING]
        </p>
      </div>

      {/* Advisory Notice */}
      <div className="p-4 bg-orange-50 border border-orange-200 rounded-2xl text-xs text-orange-800 space-y-1">
        <p className="font-extrabold uppercase tracking-wider flex items-center gap-1.5">
          <span>⚠️ Legal Draft Status Notice</span>
        </p>
        <p>
          This document is a professionally structured compliance draft prepared in accordance with the Kenya Data Protection Act, 2019. It is designed to be reviewed and signed off by a licensed advocate of the High Court of Kenya prior to formal public certification.
        </p>
      </div>

      {/* Grid of core principles */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="p-5 bg-stone-50 rounded-2xl border border-stone-200/60 space-y-3">
          <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center text-primary-green">
            <Lock size={20} />
          </div>
          <h3 className="font-extrabold text-brand-dark-text text-sm">
            {lang === 'en' ? 'Cryptographic Protection' : 'Ulinzi wa Kimkakati'}
          </h3>
          <p className="text-xs text-stone-500 leading-relaxed">
            {lang === 'en'
              ? 'Sensitive IDs are irreversibly hashed using secure industrial-grade encryption to ensure complete lookup security.'
              : 'Nambari za vitambulisho husimbwa kwa njia salama isiyoweza kurejeshwa ili kuzuia wizi wa utambulisho.'}
          </p>
        </div>

        <div className="p-5 bg-stone-50 rounded-2xl border border-stone-200/60 space-y-3">
          <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center text-primary-green">
            <Eye size={20} />
          </div>
          <h3 className="font-extrabold text-brand-dark-text text-sm">
            {lang === 'en' ? 'Explicit Consent' : 'Idhini ya Wazi'}
          </h3>
          <p className="text-xs text-stone-500 leading-relaxed">
            {lang === 'en'
              ? 'We never process physical ID cards for dispute verification without your explicit, opt-in consent.'
              : 'Hatuchakati picha za vitambulisho vyako vya kitaifa bila kupokea idhini yako ya wazi kwanza.'}
          </p>
        </div>

        <div className="p-5 bg-stone-50 rounded-2xl border border-stone-200/60 space-y-3">
          <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center text-primary-green">
            <Award size={20} />
          </div>
          <h3 className="font-extrabold text-brand-dark-text text-sm">
            {lang === 'en' ? 'Licensed Operations' : 'Shughuli Zenye Leseni'}
          </h3>
          <p className="text-xs text-stone-500 leading-relaxed">
            {lang === 'en'
              ? 'We operate in tandem with licensed Central Bank of Kenya (CBK) payment partners for maximum trust.'
              : 'Tunafanya kazi kwa karibu na washirika wa malipo walioidhinishwa na Benki Kuu ya Kenya (CBK).'}
          </p>
        </div>
      </div>

      {/* Main text content */}
      <div className="space-y-8 text-stone-700 text-sm leading-relaxed">
        
        {/* Section 1 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">1.</span> Who We Are
          </h2>
          <p>
            Return4me is operated by <strong>Jamoko Solutions Ltd</strong> (trading as "Return4me"), a private limited company incorporated under the Companies Act, 2015, operating in Kenya (Certificate of Incorporation No. [PENDING]). Jamoko Solutions Ltd is registered as a Data Controller and Data Processor with the Office of the Data Protection Commissioner (ODPC) under Certificate No. [PENDING]. Registered office: Nairobi, Kenya. Jamoko Solutions Ltd is the legal entity responsible for all obligations described in this policy; "Return4me" is the brand name under which this specific service operates.
          </p>
          <p>
            For any data protection queries, requests to exercise your rights, or compliance feedback, please contact our designated Data Protection officer: <a href="mailto:privacy@return4me.co.ke" className="text-primary-green font-bold hover:underline">privacy@return4me.co.ke</a>.
          </p>
        </section>

        {/* Section 2 */}
        <section className="space-y-4">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">2.</span> What Personal Data We Collect
          </h2>
          <p>
            We collect the minimum amount of personal data necessary to provide a secure and reliable document recovery service.
          </p>
          <div className="overflow-x-auto border border-stone-200 rounded-xl">
            <table className="min-w-full divide-y divide-stone-200 text-xs">
              <thead className="bg-stone-50">
                <tr>
                  <th className="px-4 py-3 text-left font-bold text-stone-600 uppercase">Category</th>
                  <th className="px-4 py-3 text-left font-bold text-stone-600 uppercase">Specific Data Collected</th>
                  <th className="px-4 py-3 text-left font-bold text-stone-600 uppercase">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 bg-white">
                <tr>
                  <td className="px-4 py-3 font-bold text-stone-900">Identity</td>
                  <td className="px-4 py-3 text-stone-600">Phone number, business name, agent physical address, contact representative name.</td>
                  <td className="px-4 py-3 text-stone-500">Finders, Owners, Agents</td>
                </tr>
                <tr className="bg-stone-50/40">
                  <td className="px-4 py-3 font-bold text-stone-900">Sensitive / Special Category</td>
                  <td className="px-4 py-3 text-stone-600">National ID number, passport number, other physical document identifiers, photographic copies of government ID.</td>
                  <td className="px-4 py-3 text-stone-500">Owners (disputes/Tier 3), Agents (KYC)</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-bold text-stone-900">Financial</td>
                  <td className="px-4 py-3 text-stone-600">M-Pesa transaction references, till numbers, payment amounts, payout bank/mobile money details.</td>
                  <td className="px-4 py-3 text-stone-500">Owners, Finders, Agents</td>
                </tr>
                <tr className="bg-stone-50/40">
                  <td className="px-4 py-3 font-bold text-stone-900">Content</td>
                  <td className="px-4 py-3 text-stone-600">Photographs of found documents or items (which may incidentally contain third-party personal data).</td>
                  <td className="px-4 py-3 text-stone-500">Finders</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-bold text-stone-900">Location</td>
                  <td className="px-4 py-3 text-stone-600">Approximate or GPS location of found items and Agent physical premises.</td>
                  <td className="px-4 py-3 text-stone-500">Finders, Agents</td>
                </tr>
                <tr className="bg-stone-50/40">
                  <td className="px-4 py-3 font-bold text-stone-900">Technical</td>
                  <td className="px-4 py-3 text-stone-600">Device identifiers, IP address, web browser type, date/time logs, interface usage analytics.</td>
                  <td className="px-4 py-3 text-stone-500">Automatically collected</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-stone-500 font-mono italic">
            * Document numbers and National ID numbers are treated as sensitive personal data under Section 2 of the Data Protection Act, 2019, and are handled with the elevated security controls detailed in Section 5.
          </p>
        </section>

        {/* Section 3 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">3.</span> Lawful Basis for Processing (Section 30, DPA 2019)
          </h2>
          <p>
            We process your personal data under the following legitimate lawful bases:
          </p>
          <ul className="list-disc pl-5 space-y-2 text-xs text-stone-600">
            <li>
              <strong>Performance of a Contract:</strong> Necessary to match found documents with their owners, facilitate physical drop-off and pickup, and coordinate the processing of retrieval fee escrows.
            </li>
            <li>
              <strong>Legitimate Interest:</strong> Facilitating platform security, monitoring for fraudulent claims or duplicate drop-offs, and resolving disputes. This basis is carefully balanced against your privacy expectations.
            </li>
            <li>
              <strong>Legal Obligation:</strong> Maintaining financial transaction records in compliance with standard commercial practice and Kenyan statutory requirements.
            </li>
            <li>
              <strong>Explicit Consent:</strong> Explicit, active opt-in consent is requested before any Tier 3 verification step involving the upload of a government ID copy.
            </li>
          </ul>
        </section>

        {/* Section 4 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">4.</span> Automated Decision-Making & OCR
          </h2>
          <p>
            When a finder uploads a photo of a found document, our platform uses AI-assisted Optical Character Recognition (OCR) to parse and recommend document parameters (such as name and document type).
          </p>
          <p>
            This automated tool is purely advisory. To prevent "decisions based solely on automated processing" (restricted under Section 35 of the Data Protection Act, 2019), <strong>all critical outcomes (including owner claims and dispute handovers) require active human intervention</strong> by the claimant, independent agents, or our administration team.
          </p>
        </section>

        {/* Section 5 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">5.</span> Special Protections for Government IDs & Document Numbers
          </h2>
          <p>
            We implement stringent technological guardrails to prevent the exposure of sensitive identification records:
          </p>
          <ul className="list-disc pl-5 space-y-2 text-xs text-stone-600">
            <li>
              <strong>One-Way Hashing:</strong> Document numbers and National ID numbers are never stored in raw plaintext. They are encrypted and stored as secure one-way cryptographic hashes. This allows the system to match claims without storing readable ID numbers.
            </li>
            <li>
              <strong>Masked Search:</strong> Public search queries never reveal full document numbers, names, or finder details. We display masked placeholders (e.g., "ID card ending in **456") to protect the owner's privacy.
            </li>
            <li>
              <strong>Ephemeral Proof Storage:</strong> Goverment ID photos uploaded for Tier 3 dispute resolution are stored in encrypted object containers, access-controlled only to vetting administrators, and permanently purged within 30 days of resolution.
            </li>
          </ul>
        </section>

        {/* Section 6 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">6.</span> Third-Party Sharing and Cross-Border Transfers
          </h2>
          <p>
            We never sell, rent, or monetize your personal information. Data sharing is strictly restricted to functional operations:
          </p>
          <ul className="list-disc pl-5 space-y-2 text-xs text-stone-600">
            <li>
              <strong>Return4me Agents:</strong> Vetted physical agents receive only the minimum data required to facilitate a physical pickup (such as the claimant's name and verification code). They never receive the owner's phone number or raw document photos.
            </li>
            <li>
              <strong>Licensed Payment Provider:</strong> Transaction details and phone numbers are sent directly to our Central Bank of Kenya-authorized Payment Service Provider (PSP) to process secure escrow payments. We do not hold or touch your escrow funds directly.
            </li>
            <li>
              <strong>Smart Scanning Engine:</strong> Found-document photographs are processed via a highly secure Optical Character Recognition (OCR) scanner to extract details. This involves a secure, isolated transfer aligned strictly with Section 48 of the DPA, 2019.
            </li>
          </ul>
        </section>

        {/* Section 7 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">7.</span> Data Retention Schedule
          </h2>
          <p>
            We retain data only as long as necessary to fulfill the purposes of document recovery and comply with financial regulations:
          </p>
          <ul className="list-disc pl-5 space-y-2 text-xs text-stone-600">
            <li>
              <strong>Unmatched Found-Item Reports:</strong> Retained for 12 months. After this, raw photographs are deleted and any remaining index data is completely anonymized.
            </li>
            <li>
              <strong>Matched / Completed Transactions:</strong> Retained for 7 years to meet standard statutory record-keeping expectations for commercial transactions under Kenyan tax and financial rules.
            </li>
            <li>
              <strong>Government ID Uploads (Tier 3):</strong> Permanently deleted within 30 days of claim resolution.
            </li>
            <li>
              <strong>Agent KYC and Application Records:</strong> Retained for the duration of the agent partnership plus 5 years post-termination, aligning with regulatory expectations under POCAMLA.
            </li>
          </ul>
        </section>

        {/* Section 8 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">8.</span> Your Rights (Sections 26 & 40, DPA 2019)
          </h2>
          <p>
            As a data subject in Kenya, you possess robust statutory rights. You have the right to:
          </p>
          <ul className="list-disc pl-5 space-y-1 text-xs text-stone-600">
            <li>Confirm if we hold your personal data and request access to it.</li>
            <li>Request the correction of inaccurate or false data.</li>
            <li>Request the deletion or destruction of unnecessary data.</li>
            <li>Object to or restrict the processing of your data.</li>
            <li>Withdraw consent for any voluntary processing at any time.</li>
            <li>Lodge a formal complaint directly with the Office of the Data Protection Commissioner (odpc.go.ke).</li>
          </ul>
          <p>
            To exercise these rights, please contact our DPO at <a href="mailto:privacy@return4me.co.ke" className="text-primary-green font-bold hover:underline">privacy@return4me.co.ke</a>. We will respond to and address your request within 30 days.
          </p>

          {/* Interactive DPA Section 40 Self-Service Portal */}
          <div className="bg-stone-50 border border-stone-200 rounded-2xl p-5 mt-4 space-y-4">
            <div className="flex items-start space-x-3">
              <div className="p-2 bg-red-50 text-red-600 rounded-xl shrink-0">
                <Trash2 size={18} />
              </div>
              <div className="space-y-1">
                <h3 className="font-extrabold text-stone-900 text-xs uppercase tracking-wider">
                  {lang === 'en' ? 'Section 40 Data Erasure Portal (Self-Service)' : 'Mlango wa Kujihudumia wa Kufuta Data (Kifungu cha 40)'}
                </h3>
                <p className="text-xs text-stone-500 leading-relaxed">
                  {lang === 'en'
                    ? 'Request the immediate permanent deletion or anonymization of your personal record. Requires OTP mobile verification.'
                    : 'Omba ufutaji wa kudumu au ufichaji wa utambulisho wa kumbukumbu zako za kibinafsi mara moja. Inahitaji uhakiki wa OTP wa simu.'}
                </p>
              </div>
            </div>

            {successMessage ? (
              <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-xl space-y-3">
                <p className="text-emerald-800 text-xs font-semibold leading-relaxed">
                  {successMessage}
                </p>
                <button
                  onClick={handleReset}
                  className="bg-primary-green hover:bg-primary-hover text-white text-xs font-bold px-4 py-2 rounded-xl transition cursor-pointer"
                >
                  {lang === 'en' ? 'Done' : 'Imekamilika'}
                </button>
              </div>
            ) : showErasureForm ? (
              <div className="border-t border-stone-100 pt-4">
                {!otpSent ? (
                  <form onSubmit={handleRequestOtp} className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-stone-700 block">
                        {lang === 'en' ? 'Registered Phone Number' : 'Nambari ya Simu Iliyosajiliwa'}
                      </label>
                      <input
                        type="tel"
                        required
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder={lang === 'en' ? 'e.g. 0712345678' : 'mfano 0712345678'}
                        className="w-full max-w-sm bg-white border border-stone-200 rounded-xl px-3 py-2 text-xs focus:ring-1 focus:ring-primary-green outline-none"
                      />
                    </div>

                    {error && <p className="text-red-600 text-xs font-bold">{error}</p>}

                    <div className="flex space-x-2 pt-1">
                      <button
                        type="submit"
                        disabled={loading}
                        className="bg-primary-green hover:bg-primary-hover disabled:bg-stone-300 text-white text-xs font-bold px-4 py-2 rounded-xl transition cursor-pointer"
                      >
                        {loading ? (lang === 'en' ? 'Sending...' : 'Inatuma...') : (lang === 'en' ? 'Send OTP Code' : 'Tuma Msimbo wa OTP')}
                      </button>
                      <button
                        type="button"
                        onClick={handleReset}
                        className="bg-stone-100 hover:bg-stone-200 text-stone-600 text-xs font-bold px-4 py-2 rounded-xl transition cursor-pointer"
                      >
                        {lang === 'en' ? 'Cancel' : 'Ghairi'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <form onSubmit={handleVerifyAndDelete} className="space-y-4">
                    <div className="p-3 bg-stone-100 rounded-xl flex items-center justify-between">
                      <span className="text-xs text-stone-600 font-medium">
                        {lang === 'en' ? `OTP Sent to ${phone}` : `OTP Imetumwa kwa ${phone}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => { setOtpSent(false); setError(''); }}
                        className="text-primary-green hover:underline text-xs font-bold cursor-pointer"
                      >
                        {lang === 'en' ? 'Change Phone' : 'Badilisha Simu'}
                      </button>
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-bold text-stone-700 block">
                        {lang === 'en' ? 'Enter Verification Code (OTP)' : 'Ingiza Msimbo wa Uhakiki (OTP)'}
                      </label>
                      <input
                        type="text"
                        required
                        value={otpCode}
                        onChange={(e) => setOtpCode(e.target.value)}
                        placeholder="e.g. 1234"
                        maxLength={6}
                        className="w-full max-w-sm bg-white border border-stone-200 rounded-xl px-3 py-2 text-xs font-mono focus:ring-1 focus:ring-primary-green outline-none"
                      />
                    </div>

                    <div className="flex items-start space-x-2 bg-red-50/50 border border-red-100 p-3 rounded-xl max-w-xl">
                      <input
                        type="checkbox"
                        id="consentCheck"
                        checked={consentChecked}
                        onChange={(e) => setConsentChecked(e.target.checked)}
                        className="mt-0.5 border-stone-300 rounded focus:ring-red-500 text-red-600 cursor-pointer"
                      />
                      <label htmlFor="consentCheck" className="text-xs text-stone-700 font-semibold leading-relaxed cursor-pointer select-none">
                        {lang === 'en'
                          ? 'I understand that this will permanently delete or anonymize all my personal data from Return4me systems. This action is irreversible under Section 40 of the Kenya Data Protection Act 2019.'
                          : 'Naelewa kuwa kitendo hiki kitafuta kabisa au kuficha utambulisho wa data yangu yote ya kibinafsi kwenye mifumo ya Return4me. Kitendo hiki hakiwezi kubatilishwa chini ya Kifungu cha 40 cha Sheria ya Ulinzi wa Data ya Kenya 2019.'}
                      </label>
                    </div>

                    {error && <p className="text-red-600 text-xs font-bold">{error}</p>}

                    <div className="flex space-x-2 pt-1">
                      <button
                        type="submit"
                        disabled={loading}
                        className="bg-red-600 hover:bg-red-700 disabled:bg-stone-300 text-white text-xs font-bold px-4 py-2 rounded-xl transition cursor-pointer"
                      >
                        {loading ? (lang === 'en' ? 'Processing...' : 'Inachakata...') : (lang === 'en' ? 'Permanently Erase My Data' : 'Futa Data Yangu Kabisa')}
                      </button>
                      <button
                        type="button"
                        onClick={handleReset}
                        className="bg-stone-100 hover:bg-stone-200 text-stone-600 text-xs font-bold px-4 py-2 rounded-xl transition cursor-pointer"
                      >
                        {lang === 'en' ? 'Cancel' : 'Ghairi'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            ) : (
              <div className="border-t border-stone-100 pt-3">
                <button
                  onClick={() => setShowErasureForm(true)}
                  className="bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 text-xs font-extrabold px-4 py-2.5 rounded-xl transition flex items-center space-x-2 cursor-pointer"
                >
                  <Trash2 size={14} />
                  <span>{lang === 'en' ? 'Start Data Erasure Request' : 'Anza Ombi la Kufuta Data'}</span>
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Section 9 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">9.</span> Security Safeguards & Breach Management
          </h2>
          <p>
            We protect your data using industry-standard security measures, including end-to-end TLS encryption in transit, encryption of sensitive fields at rest, strict database access controls, rate-limiting on sensitive endpoints (login, OTP, and payment), and one-way cryptographic hashing of national ID and document numbers so that raw identifiers are never stored in readable form.
          </p>
          <p>
            <strong>How we handle attempted or successful hacking incidents:</strong> If we detect unauthorized access, an attempted intrusion, or suspicious activity targeting the Platform, our incident response process includes: (1) immediately containing the affected system or account (including temporary suspension of affected agent or admin accounts where necessary), (2) investigating the scope and cause of the incident, (3) patching the vulnerability that enabled it, and (4) determining whether any personal data was actually accessed or exfiltrated, as opposed to merely being at risk.
          </p>
          <p>
            In compliance with Section 43 of the DPA, 2019, in the event of a data breach presenting a real risk of harm to your rights and freedoms, we will notify the ODPC within 72 hours of becoming aware of it, and will inform affected users without undue delay, describing: what happened, what categories of data were involved, what we have done in response, and what steps you can take to protect yourself (for example, requesting a new OTP-based login, or monitoring for suspicious M-Pesa activity).
          </p>
          <p>
            <strong>Responsible disclosure:</strong> If you are a security researcher or member of the public and believe you have found a vulnerability in the Platform (including but not limited to authentication bypass, data exposure, or payment manipulation), please report it privately to <a href="mailto:security@return4me.co.ke" className="text-primary-green font-bold hover:underline">security@return4me.co.ke</a> before disclosing it publicly. We commit to acknowledging good-faith reports within 5 business days and will not pursue legal action against researchers who report vulnerabilities responsibly, do not access other users' data beyond what is strictly necessary to demonstrate the issue, and do not disrupt the Platform for other users.
          </p>
          <p>
            <strong>Your role in keeping your account secure:</strong> OTP codes and claim pickup codes are single-use and time-limited, and Return4me staff, agents, or administrators will never ask you to read out or share an OTP or pickup code with them over the phone, WhatsApp, or SMS outside of the app flow itself. Requests of that kind, even if the caller claims to be from Return4me, are a sign of an attempted scam — do not share the code, and report the incident to us immediately.
          </p>
        </section>

        {/* Section 10 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">10.</span> Contact & Complaints
          </h2>
          <p>
            For general privacy questions, contact our Data Protection Officer at <a href="mailto:privacy@return4me.co.ke" className="text-primary-green font-bold hover:underline">privacy@return4me.co.ke</a>. For suspected security vulnerabilities, use <a href="mailto:security@return4me.co.ke" className="text-primary-green font-bold hover:underline">security@return4me.co.ke</a>. If you are unsatisfied with our response to a data protection concern, you may lodge a complaint directly with the Office of the Data Protection Commissioner of Kenya at <a href="https://www.odpc.go.ke" target="_blank" rel="noopener noreferrer" className="text-primary-green font-bold hover:underline">www.odpc.go.ke</a>.
          </p>
        </section>

      </div>

      {/* Navigation Footer button */}
      <div className="border-t border-brand-border pt-8 flex justify-center">
        <button
          onClick={() => setView('home')}
          className="bg-primary-green hover:bg-primary-hover text-white px-6 py-3 rounded-xl font-bold text-xs uppercase tracking-wider transition cursor-pointer"
        >
          {lang === 'en' ? '← Back to Home' : '← Rudi Nyumbani'}
        </button>
      </div>
    </div>
  );
}
