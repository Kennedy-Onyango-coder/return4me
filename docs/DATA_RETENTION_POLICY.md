# Return4me — Data Retention Policy

**Status:** Draft for legal/compliance review. The retention periods below are
reasonable defaults based on common practice for a Kenyan consumer platform
handling payments and personal documents, informed by the Kenya Data
Protection Act, 2019 (data minimization and storage-limitation principles)
and general Kenyan tax/financial record-keeping norms — but this document
was written by an engineer, not a lawyer, and every period marked
**[NEEDS LEGAL SIGN-OFF]** below should be confirmed against actual legal
obligations (Kenya DPA 2019, KRA tax record requirements, any sector-specific
rules) before being treated as final policy.

This is a companion document to the existing on-demand erasure mechanism
(`POST /api/auth/request-data-deletion`, backed by `db.purgeUserData`) —
that mechanism handles *user-initiated* erasure; this document defines
*time-based, automatic* retention limits for data nobody has explicitly
asked to have deleted.

---

## 1. Core principle: separate PII from financial/audit/legal records

Per the existing `purgeUserData` implementation, and continued here: **never
delete a record wholesale just because it contains someone's phone number.**
Two different things are stored together in most rows —personally
identifying information (PII), and the financial/audit facts a transaction
record exists to preserve. Retention/deletion must operate on the PII layer
(redact/anonymize) without touching the underlying financial/audit facts
(amounts, timestamps, claim IDs, ledger entries, status transitions) unless
the retention period for the *entire record* has genuinely expired.

## 2. Retention schedule by data category

| Category | What it is | Retention period | Rationale |
|---|---|---|---|
| **Finder contact data** (`items.finder_phone`, `finder_email`) | Phone/email of the person who reported a found item | Anonymized 2 years after the item's final status (claimed/expired/rejected) **[NEEDS LEGAL SIGN-OFF]** | No ongoing operational need once an item's lifecycle is over; a 2-year window covers the realistic dispute/reopening window. |
| **Owner contact data** (`claims.owner_phone`, `owner_email`, `owner_identifying_details`) | Phone/email/identity details of a claimant | Anonymized 2 years after claim resolution (released/rejected/refunded), **except** the claim that ends in `released` keeps `owner_phone` for the standard financial-record period (see Payment records below) since it's needed to reconcile a specific payout | Balances minimization against the platform's own need to answer "who was this payment for" during the financial-record window. |
| **ID proof photos** (`claims.owner_id_proof_url`, uploaded ID images) | Government ID / passport images submitted as ownership proof | Deleted (not just anonymized — the image itself) 90 days after claim resolution, **except** claims that were disputed or flagged for fraud, held 2 years **[NEEDS LEGAL SIGN-OFF]** | ID document images are the single most sensitive artifact in this system; minimize the retention window aggressively once their purpose (verifying a claim) is served. |
| **Agent ID documents** (`agents.id_document_photo_url`) | National ID used to vet an Agent partner | Retained for the duration of the Agent relationship + 2 years after termination **[NEEDS LEGAL SIGN-OFF — likely has a KYC/AML-adjacent retention obligation]** | Agents are business partners, not consumer end users; this is a vetting/compliance record, not consumer PII in the same sense. |
| **Agent shop photos** (`agents.shop_photo_url`) | Photo of the Agent's physical premises | Retained for the duration of the Agent relationship + 1 year | Lower sensitivity; kept for dispute/verification reference during and shortly after the relationship. |
| **Dispute evidence** (`dispute_evidence` table, claimant ID proofs submitted during a dispute) | Evidence submitted when two people claim the same item | Retained 2 years after dispute resolution **[NEEDS LEGAL SIGN-OFF]** | Disputes are the highest-fraud-risk workflow; a longer window protects against reopened/escalated disputes and potential legal action. |
| **Handover photos** (`claims.handover_photo_url`) | Photo of the claimant with the item at pickup, agent's fraud-prevention evidence | Deleted 2 years after the associated claim is `released` **[NEEDS LEGAL SIGN-OFF]** | Primary purpose is resolving "did the handover actually happen" disputes, which realistically surface within months, not years — but keep a safety margin. |
| **Payment records** (ledger entries, `claims.payment_reference`, amounts, M-Pesa transaction references) | Financial transaction records | **7 years** from the transaction date, per standard Kenyan financial/tax record-keeping practice **[NEEDS LEGAL SIGN-OFF — confirm against KRA requirements and Return4me's specific tax/accounting obligations]** | Financial records are the one category where a specific, well-established legal retention period is the norm rather than the exception. Amounts/dates/references are retained even after associated PII (owner_phone etc.) has been anonymized. |
| **Audit records** (`audit_log` table — admin actions, security events, erasure requests) | Who did what, when, across the platform | **7 years**, never anonymized or deleted **[NEEDS LEGAL SIGN-OFF]** | An audit log's entire value is being an unbroken, tamper-evident record. Deleting or editing audit entries — including ones that *reference* a phone number that was itself later erased under DPA request — defeats the purpose of having one. This is a deliberate, intentional exception to "anonymize PII everywhere": the audit log is the system's proof that erasure requests were correctly honored, so it must itself survive the thing it's recording. |
| **Fraud/reputation records** (`phone_reputations`, `claim_payment_strikes`) | Behavioral signals used for auto-flagging | Already deleted immediately on a verified DPA erasure request (see `purgeUserData`); absent an erasure request, retained 1 year on a rolling basis (a strike/report older than a year stops informing current risk decisions) **[NEEDS LEGAL SIGN-OFF]** | This is behavioral scoring data, not a legal/financial record — the shortest reasonable retention of any category here. |

## 3. What this document does NOT cover

- **Backups.** Retention periods above apply to the live application
  database. Backup retention/rotation is an infrastructure concern outside
  this codebase's scope — whoever manages backups needs a compatible policy
  (a purged record in production reappearing from a 3-year-old backup
  restore would violate the intent of this document even though no
  application code did anything wrong).
- **Third-party processor data.** IntaSend (payments), Africa's Talking
  (SMS), and the social platforms (Telegram/Facebook/X) each have their own
  retention policies for data that passes through them. This document
  governs what Return4me's own database retains, not what those processors
  independently keep.
- **Legal holds.** Any record subject to an active legal hold, subpoena, or
  ongoing dispute/investigation is retained regardless of the schedule
  above until the hold is lifted. No automated sweep should ever purge a
  record with `legal_hold` status set.

## 4. Implementation status

- **On-demand user erasure:** implemented (`purgeUserData`), already
  follows the PII-vs-financial-record separation principle this document
  formalizes.
- **Automated, time-based sweeps:** as of this document, one category has
  a real automated sweep implemented as a concrete proof of the pattern —
  see `handoverEvidenceRetentionSweep` in `server.ts`, which purges
  handover photos past their retention window. The remaining categories in
  the table above are **documented but not yet automated** — each would
  need its own scoped sweep function, ideally implemented one at a time
  with its own tests, the same way the handover-photo sweep was. This is
  intentionally left as documented future work rather than rushed
  wholesale, since getting the legal sign-off on each period right matters
  more than shipping every sweep at once.
