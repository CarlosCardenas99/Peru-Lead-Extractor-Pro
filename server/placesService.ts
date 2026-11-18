import { GooglePlaceRaw } from '../types';

export interface PlacesSearchResponsePayload {
  places: GooglePlaceRaw[];
  nextPageToken: string | null;
  fromCache: boolean;
}

export class PlacesApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'PlacesApiError';
    this.status = status;
    this.code = code;
  }
}

// Minimal field mask required for WEBNEX commercial evaluation + Map rendering
export const MINIMAL_PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.primaryTypeDisplayName',
  'nextPageToken',
].join(',');

export function mapGooglePlacePayload(raw: any): GooglePlaceRaw | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) return null;

  const lat = raw.location?.latitude;
  const lng = raw.location?.longitude;

  return {
    placeId: raw.id.trim(),
    displayName: raw.displayName?.text || 'Establecimiento sin nombre',
    formattedAddress: raw.formattedAddress || 'Dirección no registrada',
    location: typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null,
    nationalPhoneNumber: raw.nationalPhoneNumber || null,
    internationalPhoneNumber: raw.internationalPhoneNumber || null,
    websiteUri: raw.websiteUri || null,
    googleMapsUri: raw.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${raw.id.trim()}`,
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    userRatingCount: typeof raw.userRatingCount === 'number' ? raw.userRatingCount : null,
    businessStatus: raw.businessStatus || null,
    primaryTypeDisplayName: raw.primaryTypeDisplayName?.text || null,
  };
}

export async function searchPlacesNewApi(params: {
  textQuery: string;
  pageToken?: string;
  pageSize?: number;
  apiKey?: string;
  fetchFn?: typeof fetch;
}): Promise<PlacesSearchResponsePayload> {
  const apiKey = params.apiKey || process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new PlacesApiError(
      'La clave de Google Maps Platform no está configurada aún. Habilita Google Maps en la configuración de AI Studio.',
      503,
      'MAPS_KEY_MISSING'
    );
  }

  const fetchFn = params.fetchFn || fetch;
  const pageSize = Math.min(20, Math.max(1, params.pageSize || 20));

  const body: Record<string, unknown> = {
    textQuery: params.textQuery,
    languageCode: 'es',
    regionCode: 'PE',
    pageSize,
  };

  if (params.pageToken) {
    body.pageToken = params.pageToken;
  }

  const response = await fetchFn('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': MINIMAL_PLACES_FIELD_MASK,
      'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
    },
    body: JSON.stringify(body),
  });

  const payload: any = await response.json().catch(() => ({}));

  if (!response.ok) {
    const apiMsg = payload?.error?.message || `Error HTTP ${response.status} en Places API (New)`;
    const apiStatus = payload?.error?.status || '';

    if (response.status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
      throw new PlacesApiError(
        'Se alcanzó la cuota de solicitudes de Google Places API (New). Espera al restablecimiento diario o revisa el límite de cuota.',
        429,
        'PLACES_QUOTA_EXCEEDED'
      );
    }
    if (response.status === 403 || apiStatus === 'PERMISSION_DENIED') {
      throw new PlacesApiError(
        `Places API (New) no autorizada o bloqueada para esta clave (${apiMsg}). Verifica restricciones de clave y habilitación de Places API (New).`,
        403,
        'PLACES_PERMISSION_DENIED'
      );
    }
    throw new PlacesApiError(apiMsg, response.status, apiStatus || 'PLACES_ERROR');
  }

  const rawList = Array.isArray(payload.places) ? payload.places : [];
  const places = rawList.map(mapGooglePlacePayload).filter((p): p is GooglePlaceRaw => p !== null);

  return {
    places,
    nextPageToken: typeof payload.nextPageToken === 'string' ? payload.nextPageToken : null,
    fromCache: false,
  };
}
