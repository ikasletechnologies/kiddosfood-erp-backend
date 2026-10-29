# Franchise documents

Super Admin: /franchise ? Update Documents ? Documents.
Franchise Admin: /profile/agency ? Branch Profile ? Branch Documents.

All uploads are optional. Single-file categories have one active file; Legal Agreements and Other Documents allow multiple independent files. Replacements retain previous versions. Remove archives the active version; it does not erase historical bytes.

## Configuration and storage

- FRANCHISE_DOCUMENT_MAX_MB defaults to 10 (supported range 1–25).
- FIELD_ENCRYPTION_KEY must be the existing stable 32-byte key used by field-crypto.ts. Never regenerate it on deployment. Back up the key separately from the database.
- Document bodies reuse private Attachment storage and are AES-256-GCM encrypted. FranchiseDocument stores metadata and a private attachment reference.
- Document bodies, names and notes are excluded from API body logs. AuditLog records only actor/document/franchise IDs and action.
- Generic attachment endpoints cannot read or remove these files.

## API

All routes require existing bearer authentication and SUPER_ADMIN or FRANCHISE_ADMIN.
Base: /api/franchise/:id/documents

- GET / — current metadata; franchise users receive only their own ACTIVE, SHARED records.
- GET /?history=true — Super Admin version/archive history.
- POST / — Super Admin upload; originalFileName, mimeType, dataBase64, category. Optional replaceId, visibility (INTERNAL or SHARED), notes, issueDate and expiryDate (YYYY-MM-DD).
- PATCH /:documentId — Super Admin visibility and optional metadata changes; omitted fields remain unchanged.
- DELETE /:documentId — Super Admin archive.
- GET /:documentId/file — private authenticated download.
- GET /:documentId/file?preview=true — PDF/image preview, same authorisation.

Defaults are INTERNAL for every upload, including replacements. Sharing must be explicit. Franchise users cannot read historical or archived files, including formerly shared versions.

## Validation and limitations

PDF, JPG/JPEG, PNG, WebP, DOC/DOCX and XLS/XLSX are supported. The server checks actual image/container structures, not filenames alone. Encrypted, macro-bearing and detected active-content documents are rejected. Office previews are not provided; use download. This validation is not an antivirus scanner. There is no external malware-scanning service configured.

The additive 20261029090000_franchise_documents migration creates document metadata, foreign keys, version indexes and a partial unique active-category index. No existing franchise credentials, photos or financial records are modified.

Integration tests require a fresh disposable local database named kiddos_documents_test and KIDDOS_DOCUMENT_TEST_DB=1; they deliberately refuse an ERP database target.


## Deployment check

Restart or reload the existing backend after deploying new API routes. An unauthenticated GET or POST to /api/franchise/:id/documents must return 401, not an HTML Cannot GET/POST 404. The franchise-document-routes regression test exercises the actual app mount without writing ERP records.
