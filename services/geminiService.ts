import {
  BusinessLead,
  GeminiComplementaryAnalysis,
  GooglePlaceRaw,
  HydratedPlaceDetails,
  IndependentCorroborationResult,
  PlaceDetailsBatchItemResult,
  QuotaStatus,
  SearchParams,
  WebsiteProbeResult,
  WebsiteVerificationStatus,
} from '../types';
import { analyzePeruvianPhone } from '../utils/peruPhone';
import { checkPlaceAgainstExclusions } from '../utils/exclusionUtils';
import {
  computeContactabilityScore,
  computeDigitalOpportunityScore,
  computeInformationTrustScore,
} from '../utils/scoring';

export interface PlacesPageResponse {
  places: GooglePlaceRaw[];
  nextPageToken: string | null;
  fromCache: boolean;
  queryUsed: string;
  quota: QuotaStatus;
}

export interface SubzoneApiResponse {
  subzones: string[];
  rationale: string;
  fromCache: boolean;
  quota: QuotaStatus;
}

export interface AnalyzeLeadsResponse {
  analyses: GeminiComplementaryAnalysis[];
  modelUsed: string;
  warning: string | null;
  quota: QuotaStatus;
}

export class ApiClientError extends Error {
  status: number;
  code: string;
  quota?: QuotaStatus;

  constructor(message: string, status: number, code: string, quota?: QuotaStatus) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.quota = quota;
  }
}

export async function fetchQuotaStatus(): Promise<QuotaStatus | null> {
  try {
    const res = await fetch('/api/quota');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function searchPlacesPage(
  params: SearchParams,
  pageToken?: string
): Promise<PlacesPageResponse> {
  const res = await fetch('/api/places/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessType: params.businessType,
      location: params.location,
      subzone: params.subzone || '',
      pageToken: pageToken || undefined,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const isGoogleQuota =
      data.code === 'PLACES_QUOTA_EXCEEDED' ||
      data.quotaSource === 'google_resource_exhausted' ||
      (res.status === 429 && data.code === 'RESOURCE_EXHAUSTED');
    if (isGoogleQuota && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
    }
    throw new ApiClientError(
      data.message || `Error HTTP ${res.status} al buscar en Places API (New).`,
      res.status,
      data.code || 'PLACES_REQUEST_FAILED',
      data.quota
    );
  }
  return data;
}

export async function verifyWebsiteUrl(url: string): Promise<WebsiteProbeResult> {
  const res = await fetch('/api/verify-website', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      checkedUrl: url,
      finalUrl: null,
      status: 'unverified_inconclusive',
      httpStatus: res.status,
      tlsValid: null,
      isSocialOnly: false,
      inconclusiveReason: data.message || `Error HTTP ${res.status} al verificar URL`,
      summary: 'No verificado por error del servicio verificador',
      verifiedAt: new Date().toISOString(),
      provenance: 'independent_http',
    };
  }
  return data;
}

export async function fetchSubzoneSuggestions(
  location: string,
  businessType: string
): Promise<SubzoneApiResponse> {
  const res = await fetch('/api/subzones', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location, businessType }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiClientError(
      data.message || `Error HTTP ${res.status} al consultar Gemini.`,
      res.status,
      data.code || 'SUBZONE_FAILED',
      data.quota
    );
  }
  return data;
}

/**
 * Envía a Gemini únicamente señales técnicas independientes (estado web comprobado,
 * URL oficial para lectura HTML sin PII y notas escritas por el usuario).
 * NUNCA envía nombres, direcciones, teléfonos ni reseñas de Google Maps.
 */
export async function analyzeLeadsComplementarily(
  candidates: Array<{
    placeId: string;
    category: string;
    websiteStatus: WebsiteVerificationStatus;
    officialWebsiteUrl: string;
    userNotes: string;
  }>
): Promise<AnalyzeLeadsResponse> {
  if (candidates.length === 0) {
    return {
      analyses: [],
      modelUsed: 'none',
      warning: null,
      quota: (await fetchQuotaStatus()) || {
        dateLima: '',
        placesUsed: 0,
        placesLimit: 60,
        geminiUsed: 0,
        geminiLimit: 40,
        note: '',
      },
    };
  }

  const res = await fetch('/api/analyze-leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidates: candidates.slice(0, 8) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      analyses: [],
      modelUsed: 'none',
      warning: data.message || `Gemini no disponible (${res.status}); evaluación determinística aplicada.`,
      quota: data.quota,
    };
  }
  return data;
}

export async function corroborateLeadsIndependently(
  items: Array<{
    placeId: string;
    officialWebsiteUrl?: string | null;
    notesText?: string;
    searchCategory?: string;
    searchDistrict?: string;
  }>
): Promise<IndependentCorroborationResult[]> {
  if (items.length === 0) return [];
  const allResults: IndependentCorroborationResult[] = [];
  for (let i = 0; i < items.length; i += 10) {
    const chunk = items.slice(i, i + 10);
    const res = await fetch('/api/corroborate-independent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: chunk }),
    });
    if (!res.ok) continue;
    const data = await res.json().catch(() => ({}));
    if (Array.isArray(data.results)) {
      allResults.push(...data.results);
    }
  }
  return allResults;
}

export interface FetchPlaceDetailsBatchResponse {
  details: Record<string, HydratedPlaceDetails>;
  results: Record<string, PlaceDetailsBatchItemResult>;
  quotaExceeded: boolean;
  localQuotaReached: boolean;
  quota?: QuotaStatus;
  topLevelError?: string;
}

export async function fetchPlaceDetailsBatch(
  placeIds: string[]
): Promise<FetchPlaceDetailsBatchResponse> {
  const uniqueIds = Array.from(
    new Set(
      placeIds
        .map((id) => (id || '').trim())
        .filter((id) => id && !id.startsWith('manual_'))
    )
  ).slice(0, 5);

  if (uniqueIds.length === 0) {
    return { details: {}, results: {}, quotaExceeded: false, localQuotaReached: false };
  }

  try {
    const res = await fetch('/api/places/details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placeIds: uniqueIds }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const isLocalQuota = data.code === 'LOCAL_DAILY_QUOTA_REACHED';
      const isGoogleQuota =
        !isLocalQuota &&
        (res.status === 429 ||
          data.code === 'PLACES_QUOTA_EXCEEDED' ||
          data.quotaSource === 'google_resource_exhausted');
      if (isGoogleQuota && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
      }
      const fallbackResults: Record<string, PlaceDetailsBatchItemResult> = {};
      for (const id of uniqueIds) {
        fallbackResults[id] = {
          status: isGoogleQuota
            ? 'quota_exceeded'
            : isLocalQuota
            ? 'local_quota_exceeded'
            : 'transient_error',
          code: data.code || `HTTP_${res.status}`,
          message: data.message || `Error HTTP ${res.status} al recuperar detalles.`,
        };
      }
      return {
        details: {},
        results: fallbackResults,
        quotaExceeded: isGoogleQuota,
        localQuotaReached: isLocalQuota,
        quota: data.quota,
        topLevelError: data.message || `Error HTTP ${res.status}`,
      };
    }

    const details: Record<string, HydratedPlaceDetails> = data.details || {};
    const results: Record<string, PlaceDetailsBatchItemResult> = { ...(data.results || {}) };

    // Backfill results if any caller provided details without explicit results entry
    for (const id of uniqueIds) {
      if (!results[id] && details[id]) {
        results[id] = { status: 'loaded', details: details[id] };
      }
    }

    const quotaExceeded =
      Boolean(data.quotaExceeded) ||
      Object.values(results).some((r) => r.status === 'quota_exceeded');
    const localQuotaReached =
      Boolean(data.localQuotaReached) ||
      Object.values(results).some((r) => r.status === 'local_quota_exceeded');

    if (quotaExceeded && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
    }

    return {
      details,
      results,
      quotaExceeded,
      localQuotaReached,
      quota: data.quota,
    };
  } catch (err: any) {
    const fallbackResults: Record<string, PlaceDetailsBatchItemResult> = {};
    const message = err?.message || 'Error de red temporal al recuperar detalles de Places.';
    for (const id of uniqueIds) {
      fallbackResults[id] = {
        status: 'transient_error',
        code: 'NETWORK_ERROR',
        message,
      };
    }
    return {
      details: {},
      results: fallbackResults,
      quotaExceeded: false,
      localQuotaReached: false,
      topLevelError: message,
    };
  }
}

export function buildBusinessLeadFromPlace(
  raw: GooglePlaceRaw,
  category: string,
  exclusionKeys: Set<string>
): BusinessLead {
  const rawPhone = raw.internationalPhoneNumber || raw.nationalPhoneNumber || '';
  const phoneAnalysis = analyzePeruvianPhone(rawPhone);
  const hasWeb = Boolean(raw.websiteUri && raw.websiteUri.trim());

  const initialWebsiteProbe: WebsiteProbeResult = hasWeb
    ? {
        checkedUrl: raw.websiteUri,
        finalUrl: null,
        status: 'unverified_inconclusive',
        httpStatus: null,
        tlsValid: null,
        isSocialOnly: false,
        inconclusiveReason: 'Pendiente de verificación HTTP independiente',
        summary: 'Registrada en Google (sin verificar HTTP aún)',
        verifiedAt: '',
        provenance: 'google_absent',
      }
    : {
        checkedUrl: null,
        finalUrl: null,
        status: 'unregistered',
        httpStatus: null,
        tlsValid: null,
        isSocialOnly: false,
        inconclusiveReason: null,
        summary: 'Sin web registrada en Google Maps',
        verifiedAt: '',
        provenance: 'google_absent',
      };

  const emptyIndependentPhone = analyzePeruvianPhone('', 'none');
  const digitalScore = computeDigitalOpportunityScore(initialWebsiteProbe, false, { category });
  const contactabilityScore = computeContactabilityScore(phoneAnalysis, emptyIndependentPhone, '');
  const trustScore = computeInformationTrustScore({
    businessStatus: raw.businessStatus,
    websiteProbe: initialWebsiteProbe,
    confirmedNoWebsite: false,
    verificationSourcesCount: 0,
  });
  const exclusionMatch = checkPlaceAgainstExclusions(raw, exclusionKeys);

  return {
    placeId: raw.placeId,
    id: raw.placeId,
    name: raw.displayName,
    rating: raw.rating !== null ? raw.rating.toFixed(1) : 'N/A',
    ratingNumeric: raw.rating,
    reviews: raw.userRatingCount !== null ? String(raw.userRatingCount) : 'N/D',
    reviewsNumeric: raw.userRatingCount,
    address: raw.formattedAddress,
    phone: phoneAnalysis.formatted || (rawPhone ? rawPhone : 'Sin teléfono'),
    mapsUrl: raw.googleMapsUri,
    category,
    website: raw.websiteUri || '',
    location: raw.location,
    businessStatus: raw.businessStatus,
    primaryTypeLabel: raw.primaryTypeDisplayName,
    phoneAnalysis,
    websiteProbe: initialWebsiteProbe,
    confirmedNoWebsite: false,
    independentPhone: '',
    independentEmail: '',
    independentWebsiteNote: '',
    digitalScore,
    contactabilityScore,
    trustScore,
    exclusionMatch,
  };
}
