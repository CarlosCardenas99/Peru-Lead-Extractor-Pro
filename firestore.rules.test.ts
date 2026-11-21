import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Firestore Security Rules (Eight Pillars & Dirty Dozen Static Audit)', () => {
  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
  const rulesContent = fs.readFileSync(rulesPath, 'utf-8');

  it('incluye denegación global por defecto y verificación de UID y email_verified', () => {
    expect(rulesContent).toContain("rules_version = '2';");
    expect(rulesContent).toContain('allow read, write: if false;');
    expect(rulesContent).toContain('request.auth.token.email_verified == true');
    expect(rulesContent).toContain('request.auth.uid == userId');
  });

  it('protege exclusiones, descartados y seguimientos contra shadow fields, IDs inválidos y timestamps falsos', () => {
    expect(rulesContent).toContain('isValidId(');
    expect(rulesContent).toContain('isValidExclusion(');
    expect(rulesContent).toContain('isValidDiscard(');
    expect(rulesContent).toContain('isValidFollowup(');
    expect(rulesContent).toContain('affectedKeys().hasOnly(');
    expect(rulesContent).toContain('request.time');
    expect(rulesContent).toContain('existing().ownerUid == request.auth.uid');
    // Prohibits open public access
    expect(rulesContent).not.toMatch(/allow\s+read\s*:\s*if\s+true/);
    expect(rulesContent).not.toMatch(/allow\s+write\s*:\s*if\s+true/);
  });

  it('impone las 9 etapas comerciales y exige evidencia de base legal/consentimiento para CONTACTO AUTORIZADO y posteriores', () => {
    expect(rulesContent).toContain("'PRESELECCIONADO'");
    expect(rulesContent).toContain("'PENDIENTE DE VERIFICACIÓN'");
    expect(rulesContent).toContain("'CONTACTO AUTORIZADO'");
    expect(rulesContent).toContain("'CONTACTADO'");
    expect(rulesContent).toContain("'CLIENTE'");
    expect(rulesContent).toContain("'DESCARTADO'");
    expect(rulesContent).toContain('requiresLegalBasis(');
    expect(rulesContent).toContain('data.legalBasis.size() >= 8');
    expect(rulesContent).toContain("data.sourceKind in ['places_preselection', 'independent_manual']");
    expect(rulesContent).toContain('isValidOptionalIndependentFields(');
    expect(rulesContent).toContain("'independentAddress'");
    expect(rulesContent).toContain("'independentWebsite'");
    expect(rulesContent).toContain("'independentCategory'");
    expect(rulesContent).toContain("'independentPhoneType'");
    expect(rulesContent).toContain("'independentTrustScore'");
    expect(rulesContent).toContain("'completenessStatus'");
    expect(rulesContent).toContain("'commercialOutcome'");
    expect(rulesContent).toContain("'outcomeHistory'");
    expect(rulesContent).toContain('data.verificationSources.size() <= 8');
    expect(rulesContent).toContain('data.outcomeHistory.size() <= 10');
    expect(rulesContent).toContain('/users/{userId}/sandbox_followups/{followupId}');
  });

  it('permite eliminación controlada únicamente al propietario autenticado y verificado en followups y sandbox_followups sin exponer borrado de usuarios', () => {
    expect(rulesContent).toContain(
      'allow delete: if isOwner(userId) && isValidId(followupId) && existing().ownerUid == request.auth.uid;'
    );
    const followupsBlock = rulesContent.slice(
      rulesContent.indexOf('match /users/{userId}/followups/{followupId}'),
      rulesContent.indexOf('match /users/{userId}/sandbox_followups/{followupId}')
    );
    const sandboxBlock = rulesContent.slice(
      rulesContent.indexOf('match /users/{userId}/sandbox_followups/{followupId}')
    );
    expect(followupsBlock).toContain('allow delete:');
    expect(sandboxBlock).toContain('allow delete:');
    // Nunca permitir eliminación del documento raíz de usuario
    const userRootBlock = rulesContent.slice(
      rulesContent.indexOf('match /users/{userId}'),
      rulesContent.indexOf('match /users/{userId}/exclusions/{exclusionId}')
    );
    expect(userRootBlock).not.toContain('allow delete');
  });

  it('protege temporary_work_queue con aislamiento por propietario, TTL 12h/24h y Zero-Maps-Persistence Gate', () => {
    expect(rulesContent).toContain('isValidTemporaryWorkOutcome(');
    expect(rulesContent).toContain('isValidTemporaryWorkItem(');
    expect(rulesContent).toContain('isAllowedTemporaryWorkItemUpdate(');
    expect(rulesContent).toContain('match /users/{userId}/temporary_work_queue/{itemId}');
    expect(rulesContent).toContain('data.ttlHours in [12, 24]');
    expect(rulesContent).toContain('data.provenanceConfirmed == true');
    expect(rulesContent).toContain('data.provenanceConfirmed == false');
    expect(rulesContent).toContain("data.independentBusinessName == ''");
    expect(rulesContent).toContain("data.independentPhone == ''");
    expect(rulesContent).toContain("data.independentAddress == ''");
    expect(rulesContent).toContain("data.independentWebsite == ''");
    expect(rulesContent).toContain("data.independentEmail == ''");

    const tempQueueBlock = rulesContent.slice(
      rulesContent.indexOf('match /users/{userId}/temporary_work_queue/{itemId}')
    );
    expect(tempQueueBlock).toContain('allow get: if isOwner(userId) && isValidId(itemId);');
    expect(tempQueueBlock).toContain('allow list: if isOwner(userId) && existing().ownerUid == request.auth.uid;');
    expect(tempQueueBlock).toContain('allow create: if isOwner(userId)');
    expect(tempQueueBlock).toContain('allow update: if isOwner(userId)');
    expect(tempQueueBlock).toContain('allow delete: if isOwner(userId) && isValidId(itemId)');
  });
});

