import {
  FollowupLeadRecord,
  HydratedPlaceDetails,
  PeruvianPhoneAnalysis,
  PhoneLineType,
  PlaceDetailsBatchItemResult,
  PlaceHydrationEntry,
} from '../types';
import { analyzePeruvianPhone } from './peruPhone';

// Caché únicamente en memoria de sesión (30 min, compatible con ToS de Google Maps Platform; nunca persistido en BD)
export const SESSION_CACHE_TTL_MS = 30 * 60 * 1000;
export const ON_DEMAND_MAX_BATCH_SIZE = 5;

export function formatPhoneLineTypeLabel(lineType: PhoneLineType): string {
  switch (lineType) {
    case 'mobile':
      return 'Móvil';
    case 'landline_lima':
      return 'Fijo (Lima/Callao)';
    case 'landline_regional':
      return 'Fijo regional';
    case 'invalid':
    case 'none':
    default:
      return 'Desconocido';
  }
}

export function isHydrationEntryUsable(
  entry: PlaceHydrationEntry | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!entry || entry.status !== 'loaded' || !entry.details) return false;
  if (typeof entry.expiresAt === 'number' && nowMs >= entry.expiresAt) return false;
  return true;
}

export function selectNextHydrationBatch(
  candidatePlaceIds: string[],
  cache: Record<string, PlaceHydrationEntry>,
  options?: { isManualRetry?: boolean; maxBatchSize?: number; nowMs?: number }
): string[] {
  const isManualRetry = Boolean(options?.isManualRetry);
  const maxBatchSize = Math.max(
    1,
    Math.min(ON_DEMAND_MAX_BATCH_SIZE, options?.maxBatchSize ?? ON_DEMAND_MAX_BATCH_SIZE)
  );
  const nowMs = options?.nowMs ?? Date.now();
  const seen = new Set<string>();
  const batch: string[] = [];

  for (const rawId of candidatePlaceIds) {
    const placeId = (rawId || '').trim();
    if (!placeId || placeId.startsWith('manual_') || seen.has(placeId)) continue;
    seen.add(placeId);

    const existing = cache[placeId];
    if (existing) {
      if (isHydrationEntryUsable(existing, nowMs) || existing.status === 'loading') continue;
      if (existing.status === 'quota_exceeded' || existing.status === 'local_quota_exceeded') {
        continue;
      }
      if (!isManualRetry) {
        if (existing.status === 'unavailable' || existing.status === 'transient_error') {
          continue;
        }
      }
    }

    batch.push(placeId);
    if (batch.length >= maxBatchSize) break;
  }

  return batch;
}

export function mergeHydrationBatchResults(
  prevCache: Record<string, PlaceHydrationEntry>,
  requestedIds: string[],
  results: Record<string, PlaceDetailsBatchItemResult>,
  nowMs: number = Date.now()
): Record<string, PlaceHydrationEntry> {
  const next = { ...prevCache };

  for (const placeId of requestedIds) {
    const prev = prevCache[placeId];
    const prevUsable = isHydrationEntryUsable(prev, nowMs);
    const prevRetries = prev?.retryCount ?? 0;
    const itemResult = results[placeId];

    if (!itemResult) {
      if (prevUsable && prev) {
        next[placeId] = prev;
      } else {
        next[placeId] = {
          placeId,
          status: 'transient_error',
          details: null,
          errorCode: 'MISSING_RESULT',
          errorMessage: 'No se recibió respuesta del servidor para este Place ID.',
          retryCount: prevRetries + 1,
          updatedAt: nowMs,
        };
      }
      continue;
    }

    if (itemResult.status === 'loaded' && itemResult.details) {
      next[placeId] = {
        placeId,
        status: 'loaded',
        details: itemResult.details,
        retryCount: 0,
        updatedAt: nowMs,
        expiresAt: nowMs + SESSION_CACHE_TTL_MS,
      };
      continue;
    }

    if (itemResult.status === 'unavailable') {
      next[placeId] = {
        placeId,
        status: 'unavailable',
        details: prevUsable ? prev.details : null,
        errorCode: itemResult.code || 'PLACE_NOT_FOUND',
        errorMessage: itemResult.message || 'Establecimiento no disponible en Google Places.',
        retryCount: prevRetries + 1,
        updatedAt: nowMs,
      };
      continue;
    }

    if (itemResult.status === 'quota_exceeded') {
      if (prevUsable && prev) {
        next[placeId] = prev;
      } else {
        next[placeId] = {
          placeId,
          status: 'quota_exceeded',
          details: null,
          errorCode: itemResult.code || 'PLACES_QUOTA_EXCEEDED',
          errorMessage:
            itemResult.message ||
            'Cuota real de Google Places API (New) agotada (429 RESOURCE_EXHAUSTED).',
          retryCount: prevRetries,
          updatedAt: nowMs,
        };
      }
      continue;
    }

    if (itemResult.status === 'local_quota_exceeded') {
      if (prevUsable && prev) {
        next[placeId] = prev;
      } else {
        next[placeId] = {
          placeId,
          status: 'local_quota_exceeded',
          details: null,
          errorCode: itemResult.code || 'LOCAL_DAILY_QUOTA_REACHED',
          errorMessage:
            itemResult.message || 'Límite diario preventivo local alcanzado en el servidor.',
          retryCount: prevRetries,
          updatedAt: nowMs,
        };
      }
      continue;
    }

    // transient_error
    if (prevUsable && prev) {
      next[placeId] = prev;
    } else {
      next[placeId] = {
        placeId,
        status: 'transient_error',
        details: null,
        errorCode: itemResult.code || 'PLACE_DETAILS_ERROR',
        errorMessage: itemResult.message || 'Error temporal consultando Google Places.',
        retryCount: prevRetries + 1,
        updatedAt: nowMs,
      };
    }
  }

  return next;
}

export function getHydrationStatusMeta(
  entry: PlaceHydrationEntry | undefined,
  placeId: string,
  options?: { quotaBlocked?: boolean; nowMs?: number }
): {
  label: string;
  tone: 'neutral' | 'loading' | 'success' | 'warning' | 'error';
  canRetry: boolean;
} {
  const quotaBlocked = Boolean(options?.quotaBlocked);
  const nowMs = options?.nowMs ?? Date.now();

  if (placeId.startsWith('manual_')) {
    return { label: 'Registro independiente', tone: 'neutral', canRetry: false };
  }
  if (!entry || entry.status === 'idle') {
    return {
      label: quotaBlocked ? 'Solo datos Firebase (Places pausado)' : 'Bajo demanda (sin consultar)',
      tone: 'neutral',
      canRetry: !quotaBlocked,
    };
  }
  if (entry.status === 'loading') {
    return { label: 'Recuperando datos', tone: 'loading', canRetry: false };
  }
  if (entry.status === 'loaded') {
    if (typeof entry.expiresAt === 'number' && nowMs >= entry.expiresAt) {
      return {
        label: quotaBlocked ? 'Caché temporal expirada (Places pausado)' : 'Caché temporal expirada',
        tone: 'neutral',
        canRetry: !quotaBlocked,
      };
    }
    const hasPhone = Boolean(
      entry.details?.internationalPhoneNumber || entry.details?.nationalPhoneNumber
    );
    return {
      label: hasPhone ? 'Datos cargados (sesión)' : 'Sin teléfono registrado',
      tone: 'success',
      canRetry: false,
    };
  }
  if (entry.status === 'quota_exceeded') {
    return { label: 'Cuota real Google agotada (429)', tone: 'warning', canRetry: false };
  }
  if (entry.status === 'local_quota_exceeded') {
    return { label: 'Límite preventivo local', tone: 'warning', canRetry: false };
  }
  if (entry.status === 'unavailable') {
    return { label: 'Establecimiento no disponible', tone: 'error', canRetry: !quotaBlocked };
  }
  return { label: 'Error temporal', tone: 'warning', canRetry: !quotaBlocked };
}

export interface ResolvedFollowupPhoneDisplay {
  independentPhoneText: string | null;
  independentLineTypeLabel: string | null;
  placesPhoneText: string | null;
  placesLineTypeLabel: string | null;
  placesAnalysis: PeruvianPhoneAnalysis | null;
  independentAnalysis: PeruvianPhoneAnalysis | null;
  fallbackStatusText: string | null;
}

export function resolveFollowupPhoneDisplay(
  record: Pick<FollowupLeadRecord, 'placeId' | 'independentPhone' | 'phoneStage'>,
  hydrationEntry: PlaceHydrationEntry | undefined,
  options?: { nowMs?: number }
): ResolvedFollowupPhoneDisplay {
  const nowMs = options?.nowMs ?? Date.now();
  const cleanIndep = (record.independentPhone || '').trim();
  const independentAnalysis = cleanIndep
    ? analyzePeruvianPhone(cleanIndep, record.phoneStage)
    : null;

  const usable = isHydrationEntryUsable(hydrationEntry, nowMs);
  const details: HydratedPlaceDetails | null = usable ? hydrationEntry?.details ?? null : null;
  const rawPlacesPhone =
    details?.internationalPhoneNumber || details?.nationalPhoneNumber || '';
  const placesAnalysis = rawPlacesPhone ? analyzePeruvianPhone(rawPlacesPhone) : null;

  let fallbackStatusText: string | null = null;
  if (!cleanIndep && !rawPlacesPhone) {
    if (record.placeId.startsWith('manual_')) {
      fallbackStatusText = 'Sin información disponible';
    } else if (!hydrationEntry || hydrationEntry.status === 'idle') {
      fallbackStatusText = 'Sin consultar en Places (bajo demanda)';
    } else if (hydrationEntry.status === 'loading') {
      fallbackStatusText = 'Recuperando datos...';
    } else if (hydrationEntry.status === 'loaded') {
      fallbackStatusText = usable
        ? 'Sin teléfono registrado en Google Places'
        : 'Caché temporal de Places expirada';
    } else if (hydrationEntry.status === 'quota_exceeded') {
      fallbackStatusText = 'Cuota real de Google Places agotada (429)';
    } else if (hydrationEntry.status === 'local_quota_exceeded') {
      fallbackStatusText = 'Límite preventivo local alcanzado';
    } else if (hydrationEntry.status === 'unavailable') {
      fallbackStatusText = 'Establecimiento no disponible en Google Places';
    } else {
      fallbackStatusText = 'Error temporal al recuperar teléfono';
    }
  }

  return {
    independentPhoneText: cleanIndep
      ? independentAnalysis?.formatted || cleanIndep
      : null,
    independentLineTypeLabel: independentAnalysis
      ? formatPhoneLineTypeLabel(independentAnalysis.lineType)
      : null,
    placesPhoneText: rawPlacesPhone
      ? placesAnalysis?.formatted || rawPlacesPhone
      : null,
    placesLineTypeLabel: placesAnalysis
      ? formatPhoneLineTypeLabel(placesAnalysis.lineType)
      : null,
    placesAnalysis,
    independentAnalysis,
    fallbackStatusText,
  };
}
