# Security Specification — Peru Lead Extractor Pro (WEBNEX SYSTEMS)

## 1. Data Invariants
1. **Strict UID Isolation**: No unauthenticated user or other authenticated user may read, list, create, update, or delete another user's `/users/{userId}/exclusions`, `/discards`, or `/followups` documents.
2. **Email Verification Gate**: All reads and writes require `request.auth != null && request.auth.token.email_verified == true`.
3. **Zero Google Maps Content Persistence**: `discards` stores only `placeId` and user discard `reason`; `followups` with `sourceKind == 'places_preselection'` stores only `placeId` and proprietary/independent metadata (never Maps-sourced business names, addresses, or phones), while `independent_manual` requires a user-entered `independentBusinessName`.
4. **Contact Authorization & Legal Basis Gate**: Moving a lead into or past `CONTACTO AUTORIZADO` (`CONTACTO AUTORIZADO`, `CONTACTADO`, `RESPONDIÓ`, `INTERESADO`, `COTIZACIÓN`, `CLIENTE`) requires a verifiable `legalBasis` string (`>= 8` characters). Automatic preselection (`PRESELECCIONADO`) never grants outreach authorization.
5. **Immutable Ownership & Creation Timestamps**: `ownerUid`, `placeId`, `sourceKind`, and `createdAt` cannot be modified after document creation, and server `request.time` is enforced on all timestamps.
6. **Strict Field Allowlists (No Shadow Fields)**: Every `create` checks `hasAll` and `hasOnly`; every `update` checks `affectedKeys().hasOnly(...)` inside the validation helper envelope. Terminal `'CLIENTE'` stage locks all fields except `notes` and `updatedAt`.
7. **24h/12h Temporary Work Queue Isolation & Provenance Lock**: `/users/{userId}/temporary_work_queue/{itemId}` accepts only `ttlHours in [12, 24]`, proprietary fields (`notes`, `outcome`, `followUpDate`, `isSelected`, `priorityLabel`), `placeId`, and strictly rejects storing `independentBusinessName`, `independentPhone`, `independentAddress`, `independentWebsite`, or `independentEmail` unless `provenanceConfirmed == true` with valid `independentDataProvenance`.

## 2. Dirty Dozen Adversarial Payloads (Must Return PERMISSION_DENIED)
1. Unauthenticated read/list on `/users/uidA/exclusions`.
2. Authenticated User B attempting `get`/`list` on `/users/uidA/followups`.
3. Unverified email (`email_verified: false`) attempting `create` on `/users/uidA/followups`.
4. Spoofed `ownerUid: "uidB"` inside document written under `/users/uidA/exclusions`.
5. Shadow field injection (`isAdmin: true`) on `create` of `/users/uidA/followups`.
6. Client-forged timestamp (`createdAt: "2020-01-01"`) instead of `request.time`.
7. Oversized `notes` (> 1000 chars) or oversized `exclusionId` (> 128 chars) resource poisoning.
8. Invalid `stage` value (`"Autocontactado"`) outside the 9 allowed commercial pipeline stages.
9. Entering `CONTACTO AUTORIZADO` or `CONTACTADO` with empty or insufficient `legalBasis` (`< 8` chars).
10. Invalid `independentDigitalScore` (`150` or `-10` or string `"high"`) out of `0..100` bounds.
11. Updating immutable `createdAt`, `ownerUid`, `placeId`, or `sourceKind` during a `followups` update.
12. `discards` write where document `placeId` field does not match path `{placeId}` or `independent_manual` followup with empty `independentBusinessName`.
