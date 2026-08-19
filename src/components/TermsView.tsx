import React from 'react';
import { Scale, Coins, AlertTriangle, RefreshCw, FileText, ShieldCheck, HelpCircle } from 'lucide-react';

interface TermsViewProps {
  lang: 'en' | 'sw';
  setView: (view: any) => void;
}

export default function TermsView({ lang, setView }: TermsViewProps) {
  return (
    <div className="max-w-4xl mx-auto px-6 py-12 space-y-12 fade-in">
      {/* Header */}
      <div className="border-b border-brand-border pb-8 text-center sm:text-left">
        <span className="inline-flex items-center space-x-1 bg-orange-50 text-accent-orange border border-orange-100 font-extrabold px-3 py-1 rounded-full text-xs uppercase mb-4">
          <Scale size={12} />
          <span>Legal Agreement & Terms</span>
        </span>
        <h1 className="text-4xl font-extrabold text-primary-green tracking-tight">
          {lang === 'en' ? 'Terms of Service' : 'Vigezo na Masharti'}
        </h1>
        <p className="text-stone-500 text-sm mt-2 font-mono">
          {lang === 'en' ? 'Last Updated: July 2026' : 'Imesasishwa Mwisho: Julai 2026'} | Return4me (Jamoko Solutions Ltd)
        </p>
      </div>

      {/* Advisory Notice */}
      <div className="p-4 bg-orange-50 border border-orange-200 rounded-2xl text-xs text-orange-800 space-y-1">
        <p className="font-extrabold uppercase tracking-wider flex items-center gap-1.5">
          <span>⚠️ Legal Draft Status Notice</span>
        </p>
        <p>
          This document is a professionally structured compliance draft prepared in accordance with Kenyan commercial and consumer protection statutes. It is designed to be reviewed and signed off by a licensed advocate of the High Court of Kenya prior to formal public implementation.
        </p>
      </div>

      {/* Grid of core terms */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="p-5 bg-stone-50 rounded-2xl border border-stone-200/60 space-y-3">
          <div className="w-10 h-10 bg-orange-50 rounded-xl flex items-center justify-center text-accent-orange">
            <Coins size={20} />
          </div>
          <h3 className="font-extrabold text-brand-dark-text text-sm">
            {lang === 'en' ? 'Licensed Escrow' : 'Eskrow Yenye Leseni'}
          </h3>
          <p className="text-xs text-stone-500 leading-relaxed">
            {lang === 'en'
              ? 'All retrieval fees are processed securely via our CBK-authorized payment partner. We never hold user balances directly.'
              : 'Ada zote za urejeshaji huchakatwa kwa usalama kupitia mshirika wetu aliyopewa leseni na CBK.'}
          </p>
        </div>

        <div className="p-5 bg-stone-50 rounded-2xl border border-stone-200/60 space-y-3">
          <div className="w-10 h-10 bg-orange-50 rounded-xl flex items-center justify-center text-accent-orange">
            <AlertTriangle size={20} />
          </div>
          <h3 className="font-extrabold text-brand-dark-text text-sm">
            {lang === 'en' ? 'Zero Fraud Tolerance' : 'Sera ya Kupinga Ulaghai'}
          </h3>
          <p className="text-xs text-stone-500 leading-relaxed">
            {lang === 'en'
              ? 'Submitting fraudulent document claims is illegal. We actively coordinate with Kenyan authorities (DCI) on violations.'
              : 'Kupakia madai ghushi ya hati ni kinyume cha sheria. Tunashirikiana kwa karibu na mamlaka za usalama (DCI).'}
          </p>
        </div>

        <div className="p-5 bg-stone-50 rounded-2xl border border-stone-200/60 space-y-3">
          <div className="w-10 h-10 bg-orange-50 rounded-xl flex items-center justify-center text-accent-orange">
            <RefreshCw size={20} />
          </div>
          <h3 className="font-extrabold text-brand-dark-text text-sm">
            {lang === 'en' ? 'Refund Safeguards' : 'Uhuru wa Marejesho'}
          </h3>
          <p className="text-xs text-stone-500 leading-relaxed">
            {lang === 'en'
              ? 'If the physical agent is unable to produce the matched item, you are entitled to a full, instant refund.'
              : 'Ikitokea kuwa wakala wa makabidhiano hawezi kutoa hati yako, utarejeshewa pesa zako zote mara moja.'}
          </p>
        </div>
      </div>

      {/* Main text content */}
      <div className="space-y-8 text-stone-700 text-sm leading-relaxed">
        
        {/* Section 1 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">1.</span> Contractual Acceptance
          </h2>
          <p>
            By accessing or using the Return4me application, website, or services (collectively, the "Platform"), whether as a finder reporting a document, an owner seeking retrieval, or an agent operating a physical hub, you unconditionally agree to be bound by these Terms of Service. If you do not agree to these terms, you must immediately cease using the Platform.
          </p>
        </section>

        {/* Section 2 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">2.</span> User Eligibility
          </h2>
          <p>
            You must be at least 18 years of age and legally competent to enter into a binding contractual agreement under the laws of the Republic of Kenya. By using the Platform, you represent and warrant that you meet these eligibility criteria.
          </p>
        </section>

        {/* Section 3 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">3.</span> Nature of the Platform
          </h2>
          <p>
            Return4me is a technology marketplace and coordination service operated by <strong>Jamoko Solutions Ltd</strong> (trading as "Return4me"), a private limited company incorporated under the Companies Act, 2015, operating in Kenya. The Platform connects individual finders who drop off found documents with independent physical agents, who store these items, and owners seeking their return.
          </p>
          <p>
            <strong>Independent Contractor Status:</strong> Return4me Agents operate as independent business entities, not as employees or legal representatives of Jamoko Solutions Ltd. The physical storage and handover of found items occur directly between the physical Agent and the Owner. Jamoko Solutions Ltd's role is strictly limited to matchmaking coordination, verification tools, and escrow facilitation.
          </p>
          <p>
            <strong>Fraudulent Handover & Agent Collusion:</strong> Agents are required to photograph every claimant alongside the item at the point of handover, and to compare the claimant's in-person account against the ownership details submitted at the time of claim, before releasing any item or triggering any payout. An Agent who knowingly hands an item to someone they know or reasonably suspect is not its rightful Owner — including through collusion with a claimant — is in material breach of these Terms and their Agent Agreement. Jamoko Solutions Ltd is not liable for losses arising from an Agent's fraudulent or negligent handover; responsibility for such conduct rests with the Agent individually. Confirmed fraud or collusion will result in immediate and permanent suspension of the Agent's account, forfeiture of any commission tied to the fraudulent transaction, and referral to the Directorate of Criminal Investigations (DCI) for prosecution under the Penal Code (Cap 63) and, where applicable, the Computer Misuse and Cybercrimes Act, 2018. Owners and finders who suspect an Agent of fraudulent conduct should report it immediately via the dispute process in Section 8.
          </p>
        </section>

        {/* Section 4 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">4.</span> Fee Schedule and Settlement
          </h2>
          <p>
            The fee required to release each document category is displayed clearly in-app before the owner triggers any payment. Fees are determined based on document value, storage criteria, and transport factors. We reserve the right to modify this fee schedule periodically; however, fee updates will not apply retroactively to any active pending claim.
          </p>
        </section>

        {/* Section 5 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">5.</span> Escrow System and Fund Disbursements
          </h2>
          <p>
            To ensure complete transaction security, all retrieval fees paid by owners are processed by our licensed, CBK-authorized Payment Service Provider (PSP) partner. Jamoko Solutions Ltd does not operate as a financial institution or deposit-taking wallet.
          </p>
          <p>
            <strong>Release Conditions:</strong> Escrowed funds are held securely in a trust account until:
          </p>
          <ul className="list-disc pl-5 space-y-2 text-xs text-stone-600">
            <li>The physical agent verifies the owner's handover passcode and hands over the document;</li>
            <li>The owner confirms successful physical collection; or</li>
            <li>An administrator resolves a dispute in favor of a specific party.</li>
          </ul>
          <p>
            Once these conditions are fulfilled, the payment processor splits and disburses the retrieval fee between the Finder (finder's share), the Agent (agent's share), and Return4me (platform commission).
          </p>
        </section>

        {/* Section 6 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">6.</span> Limitation of Liability
          </h2>
          <p>
            While Jamoko Solutions Ltd makes every effort to coordinate secure handovers and vet active physical agents, the physical custody of items remains with independent agents at all times.
          </p>
          <p>
            <strong>Statutory Liability Caps:</strong> To the maximum extent permitted under Kenyan law (including the Consumer Protection Act, 2012), Jamoko Solutions Ltd's maximum aggregate liability for any loss, damage, or destruction of an item while in agent custody, or for any claim resulting from a matched handover, is strictly limited to the amount of the retrieval fee paid for that specific item. This limitation does not apply to losses caused by Jamoko Solutions Ltd’s gross negligence or intentional misconduct.
          </p>
        </section>

        {/* Section 7 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">7.</span> Refund Guarantees
          </h2>
          <p>
            We stand behind our security and recovery systems:
          </p>
          <ul className="list-disc pl-5 space-y-2 text-xs text-stone-600">
            <li>
              <strong>Unproducible Item Refund:</strong> If an owner pays the retrieval fee, but the designated physical Agent is unable to produce the physical document (e.g., due to storage loss, damage, or finder drop-off failure), the owner is entitled to a full, 100% refund of the retrieval fee, processed within 5 business days.
            </li>
            <li>
              <strong>Fraud Settlement:</strong> If a matched claim is subsequently found to have been completed fraudulently, Return4me will coordinate with law enforcement to recover funds from the perpetrator. The verified true owner will not suffer financial loss; Return4me absorbs the payout risk up to a reasonable per-incident cap.
            </li>
          </ul>
        </section>

        {/* Section 8 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">8.</span> Ownership Disputes
          </h2>
          <p>
            If multiple parties submit competing claims for the same found document, the matched transaction is immediately frozen and flagged as a "Disputed Match".competing claimants must upload government ID proofs for verification. An administrator will review both files and make a binding platform determination. This decision governs Platform actions only and does not waive or limit either party's rights to seek legal recourse in Kenyan courts.
          </p>
        </section>

        {/* Section 9 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">9.</span> Agent Commitments & Conduct
          </h2>
          <p>
            All registered Agents agree to:
          </p>
          <ul className="list-disc pl-5 space-y-1 text-xs text-stone-600">
            <li>Store physical documents in secure, dry, access-restricted spaces.</li>
            <li>Strictly verify physical identity cards and match them with Platform-issued passcodes.</li>
            <li>Abide by the Platform Agent Code of Conduct and local KYC guidelines.</li>
            <li>Refrain from contacting finders or owners directly to bypass Platform systems.</li>
          </ul>
          <p>
            Failure to adhere to these commitments will lead to immediate account suspension, forfeiture of pending escrows, and referral to authorities where theft or collusion is suspected.
          </p>
        </section>

        {/* Section 10 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">10.</span> Prohibited Activities
          </h2>
          <p>
            Platform users are strictly prohibited from:
          </p>
          <ul className="list-disc pl-5 space-y-1 text-xs text-stone-600">
            <li>Submitting false, duplicate, or counterfeit found-item reports.</li>
            <li>Submitting fraudulent ownership claims using stolen details.</li>
            <li>Using the escrow system to launder funds in violation of POCAMLA.</li>
            <li>Attempting to bypass Platform commission by coordinating direct drop-offs.</li>
            <li>Attempting to gain unauthorized access to the Platform, other users' accounts, or our systems, including through hacking, credential stuffing, exploiting software vulnerabilities, or circumventing OTP or authentication controls.</li>
            <li>Scraping, reverse-engineering, or using automated tools to extract data from the Platform without our prior written consent.</li>
            <li>Interfering with or disrupting the Platform's operation, including through denial-of-service attacks, malware, or injecting malicious code.</li>
          </ul>
          <p className="text-xs text-stone-500">
            Violations involving unauthorized access or attempts to compromise Platform security will result in immediate account termination, and where applicable, will be reported to the Directorate of Criminal Investigations (DCI) under the Computer Misuse and Cybercrimes Act, 2018.
          </p>
        </section>

        {/* Section 11 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">11.</span> Dispute Resolution and Governing Law
          </h2>
          <p>
            These Terms of Service are governed by and construed in accordance with the laws of the Republic of Kenya.
          </p>
          <p>
            In the event of any dispute arising between the parties, both agree to attempt resolution through good-faith mediation prior to initiating formal litigation. Subject to successful mediation attempts, the competent courts of Kenya shall have exclusive jurisdiction over any contractual disputes.
          </p>
        </section>

        {/* Section 12 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">12.</span> Changes to these Terms
          </h2>
          <p>
            We reserve the right to update these Terms of Service at any time. We will provide registered users with at least 14 days’ notice via in-app banner notifications or SMS alerts prior to implementing material revisions.
          </p>
        </section>

        {/* Section 13 */}
        <section className="space-y-3">
          <h2 className="text-lg font-extrabold text-primary-green flex items-center gap-2">
            <span className="text-accent-orange">13.</span> Physical Verification & 15-Minute Payment Window
          </h2>
          <div className="space-y-2">
            <p className="font-extrabold text-xs uppercase tracking-wider text-stone-500">
              English
            </p>
            <p>
              To ensure absolute transaction security and eliminate wrong matching errors, claimants must physically travel to the assigned Agent station and verify the physical document <strong>prior</strong> to authorizing payment. Payment via M-Pesa is only enabled <strong>after</strong> the physical Agent visually confirms the owner has checked and verified the item.
            </p>
            <p>
              <strong>15-Minute Payment Lockout:</strong> Upon physical Agent verification, a secure 15-minute countdown window is triggered. The owner must complete the escrow payment within this 15-minute window. If payment is not received within this time limit, the lock is automatically released, the claim is expired, and the item is returned to the public search database so other competing claimants are not blocked.
            </p>
            <p>
              <strong>Payment Strikes Policy:</strong> If a claimant triggers an agent verification but fails to make payment within the 15-minute window, a "Payment Strike" is recorded against their phone number. Receiving three (3) active payment strikes will result in an automatic, platform-wide lockout, preventing the user from submitting any further claims until cleared by an Administrator.
            </p>
          </div>
          <div className="space-y-2 border-t border-stone-100 pt-3">
            <p className="font-extrabold text-xs uppercase tracking-wider text-stone-500">
              Kiswahili
            </p>
            <p>
              Ili kuhakikisha usalama kamili na kuzuia makosa ya ulinganishaji, mdai lazima asafiri hadi kituo cha Wakala husika na kukagua hati hiyo kwa macho <strong>kabla</strong> ya kufanya malipo. Malipo kupitia M-Pesa yatawezeshwa tu <strong>baada ya</strong> Wakala kuthibitisha kuwa mwenye mali amekagua na kuthibitisha bidhaa hiyo physically.
            </p>
            <p>
              <strong>Kikomo cha Dakika 15 za Malipo:</strong> Baada ya uthibitisho wa Wakala, saa ya dakika 15 itaanza kuhesabu. Mwenye mali lazima akamilishe malipo ya eskrow ndani ya dakika hizi 15. Ikiwa malipo hayatapokelewa ndani ya muda huo, zuio litaondolewa, dai litaharibika, na hati itarudishwa kwenye mfumo wa utafutaji ili washindani wengine wasizuiwe.
            </p>
            <p>
              <strong>Sera ya Onyo la Kughairi Malipo (Payment Strikes):</strong> Ikiwa mdai ataanzisha uthibitisho wa wakala lakini akashindwa kulipa ndani ya dakika 15, "Onyo la Kughairi" (Payment Strike) litarekodiwa kwenye nambari yake ya simu. Kupokea maonyo matatu (3) kutaanzisha zuio la moja kwa moja la akaunti, na kumzuia mtumiaji kuwasilisha madai yoyote zaidi hadi hapo yatakaposafishwa na Msimamizi (Admin).
            </p>
          </div>
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
