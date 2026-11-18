# Security Specification — Peru Lead Extractor Pro (WEBNEX SYSTEMS)

## 1. Data Invariants
1. **Strict UID Isolation**: No unauthenticated user or other authenticated user may read, list, create, update, or delete another user's `/users/{userId}/exclusions`, `/discards`, or `/followups` documents.
2. **Email Verification Gate**: All reads and writes require `request.auth != null && request.auth.token.email_verified == true`.
3. **Zero Google Maps Content Persistence**: `discards` stores only `placeId` and user discard `reason`; `followups` stores only independently obtained/user-entered commercial fields.
4. **Immutable Ownership & Creation Timestamps**: `ownerUid` and `createdAt` cannot be modified after document creation, and server `request.time` is enforced on all timestamps.
5. **Strict Field Allowlists (No Shadow Fields)**: Every `create` checks `hasAll` and `hasOnly`; every `update` checks `affectedKeys().hasOnly(...)` inside the validation helper envelope.

## 2. Dirty Dozen Adversarial Payloads (Must Return PERMISSION_DENIED)
1. Unauthenticated read/list on `/users/uidA/exclusions`.
2. Authenticated User B attempting `get`/`list` on `/users/uidA/followups`.
3. Unverified email (`email_verified: false`) attempting `create` on `/users/uidA/followups`.
4. Spoofed `ownerUid: "uidB"` inside document written under `/users/uidA/exclusions`.
5. Shadow field injection (`isAdmin: true`) on `create` of `/users/uidA/followups`.
6. Client-forged timestamp (`createdAt: "2020-01-01"`) instead of `request.time`.
7. Oversized `notes` (> 1000 chars) or oversized `exclusionId` (> 128 chars) resource poisoning.
8. Invalid `stage` value (`"Autocontactado"`) outside the 8 allowed commercial pipeline stages.
9. Invalid `independentDigitalScore` (`150` or `-10` or string `"high"`) out of `0..100` bounds.
10. Updating immutable `createdAt` or `ownerUid` during a `followups` update.
11. `discards` write where document `placeId` field does not match path `{placeId}`.
12. Query `list` without `email_verified` or where `resource.data.ownerUid != request.auth.uid`.
