# Return4me - Decentralized National Lost & Found Registry

Return4me is a secure, privacy-first, tiered-verification national lost & found registry system. It helps citizens recover lost national IDs, driver's licenses, passports, and other critical documents by matching them against reported finds at registered physical physical agent locations.

The system incorporates Gemini AI OCR document analysis, cryptographic privacy hashing, fuzzy matching algorithms, tiered validation (including SMS OTP), and real-time mobile payment settlements processed via IntaSend, a CBK-licensed Payment Service Provider (PSP) which in turn settles transactions to Safaricom M-Pesa.

## Core Features

-   **Privacy-First Document Matching**: Document numbers are protected using salted HMAC-SHA256 hashes, allowing owners to search and find their exact documents without exposing sensitive document databases.
-   **Gemini AI OCR Processing**: Uploaded documents are automatically pre-scanned on the agent/finder side using Gemini to extract document numbers and names securely.
-   **Fuzzy Matching**: Uses Jaro-Winkler/Levenshtein matching on names to match claims, preventing mismatches from transcription errors.
-   **Tiered Identity Validation**:
-       **Tier 1**: Basic automated security questionnaire matching.
-       **Tier 2**: Two-factor SMS verification (OTP challenge).
-       **Tier 3**: Manual physical or high-integrity photo ID proof upload.
-   **IntaSend PSP Integration**:
-       **STK Push Collection**: Automated collection of reclaim fees from owners via IntaSend's M-Pesa STK push.
-       **Disbursement Split Outflows**: Instant split payouts to finders and physical holding agents via IntaSend's Disbursements API once a document is successfully reclaimed and verified.
-   **Cloud File Storage**: All uploaded photos (found item photos and owner ID proofs) are securely stored in S3-compatible cloud object storage (e.g., Backblaze B2).

---

## Environment Configuration

Create a `.env` file in the root directory and configure the following variables:

### Critical Security Secrets
-   `JWT_SECRET`: High-entropy salt used to sign OTP and login tokens (minimum 32 characters).
-   `DOC_HASH_SALT`: Salt value used to hash document numbers for privacy-preserving matches (minimum 32 characters).
-   `ADMIN_PASSCODE`: Passcode required to access the Return4me administration console (minimum 12 characters).

### IntaSend Payment Gateway
-   `INTASEND_PUBLISHABLE_KEY`: IntaSend account publishable/public key.
-   `INTASEND_SECRET_KEY`: IntaSend account secret API key.
-   `INTASEND_WEBHOOK_SECRET`: Optional IntaSend webhook secret for secure transaction updates.

### Cloud Object Storage
-   `STORAGE_ENDPOINT`: S3-compatible storage API endpoint (e.g., `https://s3.us-west-004.backblazeb2.com`).
-   `STORAGE_BUCKET`: S3 bucket name.
-   `STORAGE_KEY`: Access Key ID / key ID.
-   `STORAGE_SECRET`: Secret Access Key / application key.

### AI & Application Details
-   `GEMINI_API_KEY`: API key for Google Gemini model access (used for document OCR analysis).
-   `APP_URL`: Public base URL of the deployment (used for M-Pesa instant payment callbacks).
-   `CORS_ORIGIN`: Allowed origin for API requests (default: `http://localhost:3000`).

---

## Local Development Setup

### Prerequisites
-   Node.js (v18 or higher)
-   npm (v9 or higher)

### Installation
1.  Clone the repository and navigate to the project root:
    ```bash
    cd return4me
    ```
2.  Install all required dependencies:
    ```bash
    npm install
    ```
3.  Configure your environment variables inside a `.env` file as described in the **Environment Configuration** section.

### Launching the Application
-   To run the full-stack developer server (Vite frontend + Express backend):
    ```bash
    npm run dev
    ```
-   Open your browser and navigate to `http://localhost:3000`.

---

## Technical Architecture

-   **Frontend**: React 19, Tailwind CSS v4, Motion (for page transitions).
-   **Backend**: Node.js/Express, TypeScript (`tsx`).
-   **Database**: PostgreSQL with Drizzle ORM.
-   **OCR Engine**: Google GenAI SDK (`gemini-3.5-flash`).
-   **Object Storage**: `@aws-sdk/client-s3`.
