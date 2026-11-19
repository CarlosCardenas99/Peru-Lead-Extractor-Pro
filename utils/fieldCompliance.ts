import {
  COMMERCIAL_OUTCOME_OPTIONS,
  CommercialOutcomeType,
  FollowupCompletenessInfo,
  FollowupLeadRecord,
  GooglePlacesStoragePolicy,
  IndependentFieldSource,
  PhoneLineType,
  WebsiteProbeResult,
  WebsiteVerificationStatus,
} from '../types';
import { analyzePeruvianPhone } from './peruPhone';

export interface FieldStorageRule {
  field: string;
  placesOriginPolicy: GooglePlacesStoragePolicy;
  independentOriginPolicy: GooglePlacesStoragePolicy;
  explanation: string;
}

/**
 * Matriz auditable de permisos de almacenamiento conforme a Google Maps Platform ToS.
 * - El Place ID puede guardarse indefinidamente.
 * - Los campos devueltos por Places API (nombre, dirección, teléfono, web, calificación, reseñas,
 *   coordenadas, estado y categoría) se conservan SOLO en memoria de sesión (30 min máx.) y NUNCA se
 *   copian ni exportan como datos permanentes desde Google Maps.
 * - Los mismos campos comerciales SÍ pueden persistirse en Firebase y exportarse cuando provienen de
 *   fuentes independientes permitidas (web oficial del comercio, fuente empresarial autorizada o captura
 *   legítima del usuario) con trazabilidad de procedencia y fecha.
 */
export const FIELD_STORAGE_COMPLIANCE_MATRIX: FieldStorageRule[] = [
  {
    field: 'placeId',
    placesOriginPolicy: 'PERMITTED_PERMANENT_ID',
    independentOriginPolicy: 'PERMITTED_PERMANENT_ID',
    explanation: 'Identificador exento en ToS de Google Maps Platform; persistible en Firestore.',
  },
  {
    field: 'independentBusinessName',
    placesOriginPolicy: 'PROHIBITED_PERMANENT_STORAGE',
    independentOriginPolicy: 'PERMITTED_INDEPENDENT_SOURCE',
    explanation:
      'Solo se persiste en Firebase si proviene de web oficial, fuente autorizada o ingreso manual del usuario.',
  },
  {
    field: 'independentPhone / independentPhoneType',
    placesOriginPolicy: 'PROHIBITED_PERMANENT_STORAGE',
    independentOriginPolicy: 'PERMITTED_INDEPENDENT_SOURCE',
    explanation:
      'Teléfono normalizado peruano persistible únicamente si fue corroborado en web oficial o contacto legítimo.',
  },
  {
    field: 'independentAddress / district',
    placesOriginPolicy: 'PROHIBITED_PERMANENT_STORAGE',
    independentOriginPolicy: 'PERMITTED_INDEPENDENT_SOURCE',
    explanation:
      'Dirección persistible solo desde web oficial o captura del usuario; distrito puede incluir contexto de búsqueda del usuario.',
  },
  {
    field: 'independentWebsite / independentEmail',
    placesOriginPolicy: 'PROHIBITED_PERMANENT_STORAGE',
    independentOriginPolicy: 'PERMITTED_INDEPENDENT_SOURCE',
    explanation:
      'URL oficial verificada independientemente y correo corporativo extraído o ingresado legítimamente.',
  },
  {
    field: 'independentCategory',
    placesOriginPolicy: 'PROHIBITED_PERMANENT_STORAGE',
    independentOriginPolicy: 'PERMITTED_INDEPENDENT_SOURCE',
    explanation:
      'Rubro propio (JSON-LD de la web oficial o rubro consultado por el usuario), nunca primaryType copiado de Maps.',
  },
  {
    field: 'location (lat/lng), rating, userRatingCount, businessStatus',
    placesOriginPolicy: 'SESSION_MEMORY_ONLY',
    independentOriginPolicy: 'SESSION_MEMORY_ONLY',
    explanation:
      'Solo en memoria de sesión (máx. 30 min para visualización en Explorador/Mapa); prohibido replicar en BD o CSV.',
  },
];

const ALLOWED_INDEPENDENT_SOURCES: ReadonlySet<IndependentFieldSource> = new Set([
  'official_website_jsonld',
  'official_website_html',
  'authorized_public_source',
  'user_manual_entry',
  'phone_call_verified',
  'user_search_context',
  'ssrf_http_probe',
  'none',
]);

export function formatIndependentSourceLabel(source: IndependentFieldSource | string): string {
  switch (source) {
    case 'official_website_jsonld':
      return 'Web oficial (JSON-LD Schema.org)';
    case 'official_website_html':
      return 'Web oficial (HTML / contacto público)';
    case 'authorized_public_source':
      return 'Fuente empresarial autorizada';
    case 'user_manual_entry':
      return 'Captura legítima del usuario';
    case 'phone_call_verified':
      return 'Corroboración telefónica directa';
    case 'user_search_context':
      return 'Contexto de búsqueda del usuario';
    case 'ssrf_http_probe':
      return 'Sonda HTTP independiente (SSRF-safe)';
    case 'none':
    default:
      return 'Sin fuente independiente';
  }
}

export function sanitizeIndependentSource(source: unknown): IndependentFieldSource {
  const s = String(source || '').trim() as IndependentFieldSource;
  if (ALLOWED_INDEPENDENT_SOURCES.has(s)) return s;
  return 'none';
}

export function encodeVerificationProvenanceEntry(params: {
  field: string;
  source: IndependentFieldSource;
  evidence: string;
  verifiedAt: string;
}): string {
  const clean = (val: string, max: number) =>
    val.replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, max);

  const safeSource = sanitizeIndependentSource(params.source);
  if (safeSource === 'none') {
    throw new Error('No se permite registrar procedencia sin fuente independiente válida.');
  }

  return `${clean(params.field, 30)}|${safeSource}|${clean(params.evidence || 'verificado', 120)}|${clean(params.verifiedAt, 32)}`.slice(
    0,
    240
  );
}

export function parseVerificationProvenanceEntry(raw: string): {
  field: string;
  source: IndependentFieldSource;
  sourceLabel: string;
  evidence: string;
  verifiedAt: string;
} {
  const parts = String(raw || '').split('|');
  const field = parts[0] || 'registro';
  const source = sanitizeIndependentSource(parts[1]);
  const evidence = parts[2] || '';
  const verifiedAt = parts[3] || '';
  return {
    field,
    source,
    sourceLabel: formatIndependentSourceLabel(source),
    evidence,
    verifiedAt,
  };
}

export function mergeVerificationSources(
  existing: string[] | undefined,
  incoming: string[],
  maxItems: number = 8
): string[] {
  const merged: string[] = [];
  const seenKeys = new Set<string>();

  // Priorizar entradas nuevas para campos actualizados sin duplicar el mismo campo+fuente
  for (const raw of [...incoming, ...(existing || [])]) {
    const trimmed = String(raw || '').trim().slice(0, 240);
    if (!trimmed) continue;
    const parsed = parseVerificationProvenanceEntry(trimmed);
    const dedupKey = `${parsed.field}::${parsed.source}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);
    merged.push(trimmed);
    if (merged.length >= maxItems) break;
  }

  return merged;
}

export function resolveIndependentPhoneType(
  phone: string | undefined,
  explicitType?: PhoneLineType
): PhoneLineType {
  if (explicitType && explicitType !== 'none') return explicitType;
  const trimmed = (phone || '').trim();
  if (!trimmed) return 'none';
  return analyzePeruvianPhone(trimmed).lineType;
}

export function getCommercialOutcomeLabel(outcome: CommercialOutcomeType | string | undefined): string {
  const found = COMMERCIAL_OUTCOME_OPTIONS.find((o) => o.value === outcome);
  return found ? found.label : 'Sin resultado registrado';
}

export function encodeOutcomeHistoryEntry(params: {
  outcome: CommercialOutcomeType;
  source: string;
  context: string;
  recordedAt: string;
}): string {
  const clean = (val: string, max: number) =>
    String(val || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, max);

  return `${params.outcome}|${clean(params.source || 'registro_crm', 60)}|${clean(
    params.context || 'Sin detalle',
    120
  )}|${clean(params.recordedAt, 32)}`.slice(0, 240);
}

export function parseOutcomeHistoryEntry(raw: string): {
  outcome: CommercialOutcomeType;
  label: string;
  source: string;
  context: string;
  recordedAt: string;
} {
  const parts = String(raw || '').split('|');
  const rawOutcome = (parts[0] || 'none') as CommercialOutcomeType;
  const known = COMMERCIAL_OUTCOME_OPTIONS.some((o) => o.value === rawOutcome) ? rawOutcome : 'none';
  return {
    outcome: known,
    label: getCommercialOutcomeLabel(known),
    source: parts[1] || 'registro_crm',
    context: parts[2] || '',
    recordedAt: parts[3] || '',
  };
}

export function mergeOutcomeHistory(
  existing: string[] | undefined,
  newEntry: string,
  maxItems: number = 10
): string[] {
  const cleanNew = String(newEntry || '').trim().slice(0, 240);
  const prev = Array.isArray(existing)
    ? existing.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.slice(0, 240))
    : [];
  const merged = cleanNew ? [cleanNew, ...prev] : prev;
  return merged.slice(0, maxItems);
}

/**
 * Evalúa qué tan completa está la ficha PERSISTENTE de un prospecto en Firebase
 * (considerando exclusivamente datos independientes legítimos, nunca caché de Maps).
 * Marca explícitamente como FICHA INCOMPLETA si faltan campos comerciales esenciales.
 */
export function evaluateFollowupCompleteness(
  record: Pick<
    FollowupLeadRecord,
    | 'independentBusinessName'
    | 'independentPhone'
    | 'independentAddress'
    | 'district'
    | 'independentWebsite'
    | 'confirmedNoWebsite'
    | 'independentEmail'
    | 'independentCategory'
  >
): FollowupCompletenessInfo {
  const presentFields: string[] = [];
  const missingFields: string[] = [];

  if (record.independentBusinessName?.trim()) presentFields.push('Nombre comercial');
  else missingFields.push('Nombre comercial');

  if (record.independentPhone?.trim()) presentFields.push('Teléfono');
  else missingFields.push('Teléfono');

  if (record.independentAddress?.trim() || record.district?.trim()) {
    presentFields.push(record.independentAddress?.trim() ? 'Dirección' : 'Distrito');
  } else {
    missingFields.push('Dirección / Distrito');
  }

  if (record.independentWebsite?.trim() || record.confirmedNoWebsite) {
    presentFields.push(record.confirmedNoWebsite ? 'Confirmado sin web' : 'Sitio web');
  } else {
    missingFields.push('Sitio web / confirmación');
  }

  if (record.independentCategory?.trim()) presentFields.push('Categoría');
  else missingFields.push('Categoría');

  if (record.independentEmail?.trim()) presentFields.push('Correo');

  const coreChecked = 4; // Nombre, Teléfono, Ubicación (Dirección o Distrito), Web/Sin-Web
  const coreHave = [
    Boolean(record.independentBusinessName?.trim()),
    Boolean(record.independentPhone?.trim()),
    Boolean(record.independentAddress?.trim() || record.district?.trim()),
    Boolean(record.independentWebsite?.trim() || record.confirmedNoWebsite),
  ].filter(Boolean).length;

  const percent = Math.round((coreHave / coreChecked) * 100);

  if (coreHave >= 4) {
    return {
      status: 'complete',
      isFichaIncompleta: false,
      label: 'Ficha persistente completa',
      presentFields,
      missingFields,
      percent: 100,
    };
  }
  if (presentFields.length > 0) {
    return {
      status: 'partial',
      isFichaIncompleta: true,
      label: `FICHA INCOMPLETA (${coreHave}/4 campos clave)`,
      presentFields,
      missingFields,
      percent,
    };
  }
  return {
    status: 'place_id_only',
    isFichaIncompleta: true,
    label: 'FICHA INCOMPLETA (Solo Place ID)',
    presentFields,
    missingFields,
    percent: 0,
  };
}

/**
 * Determina el estado HTTP persistible de una URL independiente antes de guardar en Firestore.
 * - Si está confirmado sin web -> 'confirmed_none'.
 * - Si hay URL ingresada manualmente y NO coincide con una sonda HTTP independiente ya completada:
 *   - Si sintaxis inválida -> 'invalid_url'.
 *   - Si sintaxis válida -> 'unverified_inconclusive' (no verificada hasta comprobarla; nunca se descarta ni se marca activa).
 */
export function resolveIndependentWebsiteStatusForSave(params: {
  independentWebsite?: string;
  confirmedNoWebsite: boolean;
  verifiedProbe?: WebsiteProbeResult | null;
}): WebsiteVerificationStatus {
  if (params.confirmedNoWebsite) {
    return 'confirmed_none';
  }

  const rawUrl = (params.independentWebsite || '').trim();
  if (!rawUrl) {
    if (params.verifiedProbe && params.verifiedProbe.provenance === 'independent_http') {
      return params.verifiedProbe.status;
    }
    return 'unregistered';
  }

  let parsed: URL | null = null;
  try {
    const candidate = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const u = new URL(candidate);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.')) {
      parsed = u;
    }
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return 'invalid_url';
  }

  const normalize = (u: string) =>
    u.trim().toLowerCase().replace(/\/+$/, '');
  const targetNorm = normalize(parsed.toString());
  const rawNorm = normalize(rawUrl);

  const probe = params.verifiedProbe;
  if (probe && probe.provenance === 'independent_http') {
    const checkedNorm = probe.checkedUrl ? normalize(probe.checkedUrl) : '';
    const finalNorm = probe.finalUrl ? normalize(probe.finalUrl) : '';
    if (
      checkedNorm === targetNorm ||
      checkedNorm === rawNorm ||
      finalNorm === targetNorm ||
      finalNorm === rawNorm
    ) {
      return probe.status;
    }
  }

  return 'unverified_inconclusive';
}

export interface PersistedVerificationReport {
  isComplete: boolean;
  status: 'complete' | 'partial' | 'place_id_only';
  missingReasons: string[];
  persistedCoreSummary: string;
}

/**
 * Evalúa la completitud real EXCLUSIVAMENTE desde el documento leído de Firestore
 * y detalla exactamente qué campos faltan y por qué.
 */
export function buildPersistedVerificationReport(
  persistedRecord: Pick<
    FollowupLeadRecord,
    | 'independentBusinessName'
    | 'independentPhone'
    | 'independentAddress'
    | 'district'
    | 'independentWebsite'
    | 'independentWebsiteStatus'
    | 'confirmedNoWebsite'
    | 'independentEmail'
    | 'independentCategory'
  >
): PersistedVerificationReport {
  const completeness = evaluateFollowupCompleteness(persistedRecord);
  const missingReasons: string[] = [];

  if (!persistedRecord.independentBusinessName?.trim()) {
    missingReasons.push(
      'Nombre comercial: vacío en Firestore (ingresa el nombre propio o corrige desde web oficial).'
    );
  }
  if (!persistedRecord.independentPhone?.trim()) {
    missingReasons.push(
      'Teléfono: vacío en Firestore (ingresa o corrobora un número independiente válido).'
    );
  }
  if (!persistedRecord.independentAddress?.trim() && !persistedRecord.district?.trim()) {
    missingReasons.push(
      'Dirección / Distrito: ambos vacíos en Firestore.'
    );
  } else if (!persistedRecord.independentAddress?.trim()) {
    missingReasons.push(
      'Dirección exacta: aún vacía en Firestore (solo se guardó distrito).'
    );
  }
  if (!persistedRecord.independentWebsite?.trim() && !persistedRecord.confirmedNoWebsite) {
    missingReasons.push(
      'Sitio web / confirmación sin web: vacío en Firestore (ingresa la URL oficial o confirma que no posee web).'
    );
  } else if (
    persistedRecord.independentWebsite?.trim() &&
    persistedRecord.independentWebsiteStatus === 'unverified_inconclusive'
  ) {
    missingReasons.push(
      'Sitio web guardado en Firestore como NO VERIFICADO (pendiente de comprobación HTTP SSRF-safe).'
    );
  }
  if (!persistedRecord.independentCategory?.trim()) {
    missingReasons.push('Categoría comercial propia: vacía en Firestore.');
  }

  const summaryParts = [
    persistedRecord.independentBusinessName?.trim()
      ? `Nombre: "${persistedRecord.independentBusinessName.trim()}"`
      : 'Nombre: (vacío)',
    persistedRecord.independentPhone?.trim()
      ? `Tel: "${persistedRecord.independentPhone.trim()}"`
      : 'Tel: (vacío)',
    persistedRecord.independentAddress?.trim()
      ? `Dir: "${persistedRecord.independentAddress.trim()}"`
      : persistedRecord.district?.trim()
      ? `Distrito: "${persistedRecord.district.trim()}" (sin dirección)`
      : 'Dir: (vacía)',
    persistedRecord.independentWebsite?.trim()
      ? `Web: "${persistedRecord.independentWebsite.trim()}" (${persistedRecord.independentWebsiteStatus})`
      : persistedRecord.confirmedNoWebsite
      ? 'Web: Confirmado sin web'
      : 'Web: (vacía)',
  ];

  return {
    isComplete: completeness.status === 'complete',
    status: completeness.status,
    missingReasons,
    persistedCoreSummary: summaryParts.join(' · '),
  };
}

/**
 * Guardia anti-suplantación: verifica explícitamente que ningún candidato persistente
 * provenga de campos crudos de Google Maps cuando falta fuente independiente.
 */
export function isIndependentEntryDistinctFromRawMapsGuard(params: {
  source: IndependentFieldSource;
}): boolean {
  return params.source !== 'none' && ALLOWED_INDEPENDENT_SOURCES.has(params.source);
}
