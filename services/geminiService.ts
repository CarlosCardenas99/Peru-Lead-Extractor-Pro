import {
  BusinessLead,
  GeminiComplementaryAnalysis,
  GooglePlaceRaw,
  HydratedPlaceDetails,
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
    if (
      res.status === 429 &&
      (data.code === 'PLACES_QUOTA_EXCEEDED' || data.code === 'RESOURCE_EXHAUSTED') &&
      typeof window !== 'undefined'
    ) {
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

export async function fetchPlaceDetailsBatch(placeIds: string[]): Promise<{
  details: Record<string, HydratedPlaceDetails>;
  quota?: QuotaStatus;
}> {
  if (placeIds.length === 0) return { details: {} };
  const res = await fetch('/api/places/details', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ placeIds: placeIds.slice(0, 10) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { details: {}, quota: data.quota };
  }
  return { details: data.details || {}, quota: data.quota };
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
  const digitalScore = computeDigitalOpportunityScore(initialWebsiteProbe, false);
  const contactabilityScore = computeContactabilityScore(phoneAnalysis, emptyIndependentPhone, '');
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
    exclusionMatch,
  };
}
