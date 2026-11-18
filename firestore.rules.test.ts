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
});
