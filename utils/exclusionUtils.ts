import { ExclusionRecord, GooglePlaceRaw } from '../types';
import { analyzePeruvianPhone } from './peruPhone';

const SOCIAL_HOSTS = new Set([
  'facebook.com',
  'm.facebook.com',
  'fb.com',
  'instagram.com',
  'tiktok.com',
  'linktr.ee',
  'wa.me',
  'api.whatsapp.com',
  'whatsapp.com',
  'youtube.com',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'sites.google.com',
  'bio.link',
]);

export function normalizeDomainOrSocialKey(rawUrlOrDomain: string | null | undefined): string | null {
  const trimmed = (rawUrlOrDomain || '').trim().toLowerCase();
  if (!trimmed || trimmed === 'n/a' || trimmed === '-') return null;

  try {
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(candidate);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (!host || !host.includes('.')) return null;

    if (SOCIAL_HOSTS.has(host)) {
      const cleanPath = parsed.pathname.replace(/\/+$/, '').toLowerCase();
      return cleanPath && cleanPath !== '/' ? `${host}${cleanPath}` : null;
    }

    return host;
  } catch {
    return null;
  }
}

export interface ParsedExclusionCandidate {
  type: 'phone' | 'domain' | 'placeId';
  normalizedValue: string;
  rawSample: string;
}

export interface ExclusionBatchParseResult {
  uniqueEntries: ParsedExclusionCandidate[];
  skippedDuplicates: number;
  skippedUnrecognized: number;
  totalLinesProcessed: number;
}

/**
 * Parsea listas CSV/TXT/pegadas de exclusiones (ej. histórico WEBNEX de 4,767 descartados),
 * normalizando teléfonos peruanos, dominios y Place IDs, y evitando duplicados.
 */
export function parseExclusionBatchInput(
  rawText: string,
  existingKeys: Set<string>,
  maxEntries: number = 10000
): ExclusionBatchParseResult {
  const lines = rawText.split(/\r?\n/);
  const seenInBatch = new Set<string>();
  const uniqueEntries: ParsedExclusionCandidate[] = [];
  let skippedDuplicates = 0;
  let skippedUnrecognized = 0;
  let totalLinesProcessed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Skip obvious CSV header rows
    if (
      i === 0 &&
      /^(telefono|phone|celular|dominio|domain|website|web|place_?id|nombre|empresa)/i.test(line)
    ) {
      continue;
    }

    totalLinesProcessed++;
    const tokens = line
      .split(/[,\t;|]+/)
      .map((t) => t.replace(/^["']|["']$/g, '').trim())
      .filter(Boolean);

    let matchedAnyTokenInLine = false;

    for (const token of tokens) {
      if (uniqueEntries.length >= maxEntries) break;

      // 1. Google Place ID check (usually starts with ChIJ / GhIJ / Ej...)
      if (/^(ChIJ|GhIJ|Eh)[A-Za-z0-9_-]{10,}$/.test(token)) {
        const key = `placeId:${token}`;
        matchedAnyTokenInLine = true;
        if (existingKeys.has(key) || seenInBatch.has(key)) {
          skippedDuplicates++;
        } else {
          seenInBatch.add(key);
          uniqueEntries.push({
            type: 'placeId',
            normalizedValue: token,
            rawSample: token.slice(0, 120),
          });
        }
        continue;
      }

      // 2. Peruvian phone check
      const phoneAnalysis = analyzePeruvianPhone(token);
      if (phoneAnalysis.isValidFormat && phoneAnalysis.e164) {
        const key = `phone:${phoneAnalysis.e164}`;
        matchedAnyTokenInLine = true;
        if (existingKeys.has(key) || seenInBatch.has(key)) {
          skippedDuplicates++;
        } else {
          seenInBatch.add(key);
          uniqueEntries.push({
            type: 'phone',
            normalizedValue: phoneAnalysis.e164,
            rawSample: token.slice(0, 120),
          });
        }
        continue;
      }

      // 3. Domain / URL check
      if (token.includes('.') && !/\s/.test(token) && !token.includes('@')) {
        const domain = normalizeDomainOrSocialKey(token);
        if (domain) {
          const key = `domain:${domain}`;
          matchedAnyTokenInLine = true;
          if (existingKeys.has(key) || seenInBatch.has(key)) {
            skippedDuplicates++;
          } else {
            seenInBatch.add(key);
            uniqueEntries.push({
              type: 'domain',
              normalizedValue: domain,
              rawSample: token.slice(0, 120),
            });
          }
          continue;
        }
      }

      // 4. Email domain extraction (if user pasted contact emails)
      if (token.includes('@') && !/\s/.test(token)) {
        const domainPart = token.split('@')[1];
        const domain = normalizeDomainOrSocialKey(domainPart);
        if (domain && !['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com'].includes(domain)) {
          const key = `domain:${domain}`;
          matchedAnyTokenInLine = true;
          if (existingKeys.has(key) || seenInBatch.has(key)) {
            skippedDuplicates++;
          } else {
            seenInBatch.add(key);
            uniqueEntries.push({
              type: 'domain',
              normalizedValue: domain,
              rawSample: token.slice(0, 120),
            });
          }
        }
      }
    }

    if (!matchedAnyTokenInLine) {
      skippedUnrecognized++;
    }
  }

  return {
    uniqueEntries,
    skippedDuplicates,
    skippedUnrecognized,
    totalLinesProcessed,
  };
}

export function buildExclusionKeySet(records: ExclusionRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const r of records) {
    keys.add(`${r.type}:${r.normalizedValue}`);
  }
  return keys;
}

export function checkPlaceAgainstExclusions(
  place: Pick<GooglePlaceRaw, 'placeId' | 'nationalPhoneNumber' | 'internationalPhoneNumber' | 'websiteUri'>,
  exclusionKeys: Set<string>
): { excluded: boolean; matchedRule: string | null } {
  if (exclusionKeys.has(`placeId:${place.placeId}`)) {
    return { excluded: true, matchedRule: `Place ID excluido (${place.placeId})` };
  }

  const phone = analyzePeruvianPhone(place.internationalPhoneNumber || place.nationalPhoneNumber);
  if (phone.e164 && exclusionKeys.has(`phone:${phone.e164}`)) {
    return { excluded: true, matchedRule: `Teléfono en lista de exclusión (${phone.formatted || phone.e164})` };
  }

  const domain = normalizeDomainOrSocialKey(place.websiteUri);
  if (domain && exclusionKeys.has(`domain:${domain}`)) {
    return { excluded: true, matchedRule: `Dominio en lista de exclusión (${domain})` };
  }

  return { excluded: false, matchedRule: null };
}
