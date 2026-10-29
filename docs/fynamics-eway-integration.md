# Fynamics E-Way Bill integration

The existing `POST /:id/submit` and `POST /:id/generate` E-Way Bill routes now use the shared backend service. The request supplies the saved draft ID; typed E-Way Bill numbers are no longer accepted as generation evidence. `POST /:id/reconcile` looks up an uncertain submission. Existing GET/detail records expose the official `ewbNumber`, `ewbDate`, and `validUntil` for existing viewing/printing consumers.

## Configuration and deployment

Apply the additive migration with the normal deployment process (`npm run prisma:deploy`); no migration was applied to a database during implementation. Configure backend environment variables listed in `.env.example`. The taxpayer username/password must be API credentials registered on the E-Way Bill portal, separate from gateway client credentials. The configured GSTIN must match the draft consignor. Multiple taxpayer accounts and standard/encrypted-only accounts are not supported in this version; enhanced API access must be enabled for the account.

Only `https://staging.fynamics.co.in/api` is permitted. The official staging Swagger uses the relative server `/api`. Production is deliberately blocked. Fynamics labels its public reference server as Sandbox, but the staging documentation does not explicitly guarantee legal validity characteristics: obtain confirmation from Fynamics before submitting any real document. No external authentication or generation call was performed, and supplied credentials were not saved in the repository.

## Verified contract

Official staging OpenAPI: https://staging.fynamics.co.in/public/assets/yaml/api_eway.yaml (linked by the staging documentation's Swagger script).

- POST `/authenticate`: clientId/clientSecret headers, no body; `status`, `data.accessToken`, `data.expiresIn` (seconds).
- POST `/eway/enhanced/authentication`: Bearer gateway token and gstin header; action ACCESSTOKEN, username and password body; `Status`, `Data.AuthToken`, `Data.Sek`, `Data.TokenExpiry`.
- POST `/eway/enhanced/generate`: Bearer token, gstin, username, authtoken and sek headers; plaintext enhanced payload. Official response uses `status`, `ewayBillNo`, `ewayBillDate`, `validUpto`. No standard API encryption is mixed in.
- GET `/eway/enhanced/bills-generated-consigner/{docType}/{docNo}`: reconcile active bills after an uncertain result. No automatic generation retry is performed.

Tokens and SEK are cached in memory only, with authentication single-flight and expiry refresh. Provider errors clear authentication for the next attempt. Generation is never automatically replayed after token rejection. HTTP transport errors are replaced with safe messages; raw fetch headers, bodies and provider responses are never logged or stored. Response persistence is limited to official number/dates, provider/environment identity, generator GSTIN and redacted errors. Provider responses do not document a separate generation reference.

## Safety and recovery

A short database transaction takes the existing advisory lock, checks source aliases/document identity, and persists PROCESSING before the external submission. The transaction ends before calling the provider. Editing/deleting processing records is blocked; concurrent submissions cannot claim the same draft. Provider success followed by a persistence failure leaves PROCESSING for reconciliation. No inventory or source invoice writes are performed.

Definite failures use FAILED and remain editable. Network errors, unexpected responses, duplicate messages, and numeric generation error codes conservatively retain PROCESSING. Numeric code-only errors are displayed verbatim; no undocumented code descriptions are invented. Reconcile these before retrying. A failed/negative reconciliation does not automatically release the draft: only active bills are returned by this provider endpoint, so absence alone cannot prove safe regeneration. An operator must verify the provider record before any database recovery. This also applies to a crash between claiming PROCESSING and submission.

Provider-backed vehicle changes, extension and cancellation are blocked from local-only mutation; use the authorised portal until those external lifecycle operations are implemented. Historical portal-only records keep their existing behavior. Provider changes made in the portal are not automatically synchronized.

## Validation and remaining work

Fixture tests cover authentication contracts, caching, server headers, payload mapping for all three sources, official response parsing, reconciliation, production blocking, taxpayer mismatch, credential redaction and connection failures. Run `npm run build`, then `node --test dist/tests/sales/fynamics.client.test.js`. Existing database integration tests require their explicitly disposable local test database; do not run against business data.

This workspace contains only the backend. The frontend must consume `generationAvailable`, call submit with the draft ID, disable repeated submission, show processing/failure feedback and render saved official results. No frontend build or browser View/Print/Download verification was possible here. The backend cannot report connecting/generating intermediate phases to an already-running HTTP request; use the existing GET record for persisted PROCESSING status. No fake intermediate success is emitted.

Separately authorize a staging end-to-end test after configuring taxpayer credentials and applying the migration. Authentication success, account enhanced support and official generation remain unverified until that test. Database concurrency, historical records and source integration tests also require the disposable database environment.
