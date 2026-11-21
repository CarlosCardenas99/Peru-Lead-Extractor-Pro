import {
  BusinessLead,
  CommercialOutcomeType,
  FollowupStage,
  PersistedTemporaryWorkItem,
  TEMPORARY_QUEUE_OUTCOMES,
  TemporaryQueueEntry,
  TemporaryQueueIndependentDraft,
  TemporaryQueueOutcome,
  TemporaryQueueOutcomeMeta,
  TemporaryQueuePriority,
  TemporaryQueueTtlHours,
} from '../types';
import { analyzePeruvianPhone } from './peruPhone';

export interface AddToTemporaryQueueResult {
  queue: TemporaryQueueEntry[];
  addedCount: number;
  skippedDuplicates: number;
  addedPlaceIds: string[];
}

export function computeExpiryIso(addedAtIso: string, ttlHours: TemporaryQueueTtlHours): {
  expiresAtIso: string;
  expiresAtEpochMs: number;
} {
  const baseMs = Date.parse(addedAtIso);
  const startMs = Number.isFinite(baseMs) ? baseMs : Date.now();
  const expiresAtEpochMs = startMs + ttlHours * 60 * 60 * 1000;
  return {
    expiresAtEpochMs,
    expiresAtIso: new Date(expiresAtEpochMs).toISOString(),
  };
}

export function createEmptyIndependentDraft(
  lead: Partial<BusinessLead>,
  options?: { district?: string; category?: string }
): TemporaryQueueIndependentDraft {
  return {
    independentBusinessName: '',
    independentPhone: lead.independentPhone?.trim() || '',
    independentAddress: '',
    district: (options?.district || '').replace(/,?\s*per[uú]$/i, '').trim(),
    independentWebsite: '',
    independentEmail: lead.independentEmail?.trim() || '',
    independentCategory: (options?.category || lead.category || '').trim(),
    confirmedNoWebsite: Boolean(lead.confirmedNoWebsite),
    legalBasis: '',
    provenanceConfirmed: false,
    independentDataProvenance: '',
  };
}

/**
 * Construye una referencia limpia de sesión cuando un ítem recuperado desde Firestore (< 12h/24h)
 * ya no tiene datos temporales de Google Maps en memoria RAM.
 * Jamás inventa nombre/teléfono ni llama a Google Place Details.
 */
export function buildSessionPlaceholderLead(item: {
  placeId: string;
  searchCategory?: string;
  confirmedNoWebsite?: boolean;
  independentPhone?: string;
  independentEmail?: string;
}): BusinessLead {
  const cleanPhone = (item.independentPhone || '').trim();
  const phoneAnalysis = analyzePeruvianPhone(
    cleanPhone,
    cleanPhone ? 'independently_corroborated' : 'none'
  );

  return {
    placeId: item.placeId,
    id: item.placeId,
    name: '',
    rating: '',
    ratingNumeric: null,
    reviews: '',
    reviewsNumeric: null,
    category: item.searchCategory || 'Comercio',
    address: '',
    phone: 'No disponible tras reinicio (solo sesión Maps)',
    phoneAnalysis,
    website: '',
    websiteProbe: {
      checkedUrl: null,
      finalUrl: null,
      status: item.confirmedNoWebsite ? 'confirmed_none' : 'unregistered',
      httpStatus: null,
      tlsValid: null,
      isSocialOnly: false,
      inconclusiveReason: null,
      summary: item.confirmedNoWebsite
        ? 'Sin web propia confirmada'
        : 'Sin referencia temporal Maps en RAM',
      verifiedAt: new Date().toISOString(),
      provenance: item.confirmedNoWebsite ? 'manual_user' : 'google_absent',
    },
    digitalScore: {
      score: item.confirmedNoWebsite ? 90 : 50,
      label: 'Recuperado de sesión anterior',
      isIndependentlyVerified: Boolean(item.confirmedNoWebsite),
      reasons: [],
      breakdown: [],
    },
    contactabilityScore: {
      score: cleanPhone ? 70 : 10,
      label: cleanPhone ? 'Teléfono independiente recuperado' : 'Solo Place ID recuperado',
      isIndependentlyCorroborated: Boolean(cleanPhone),
      reasons: [],
      breakdown: [],
    },
    trustScore: {
      score: cleanPhone ? 65 : 25,
      label: 'Recuperado desde respaldo temporal 24h',
      isOperational: true,
      hasContradictions: false,
      contradictions: [],
      missingCoreFields: [],
      reasons: [],
      breakdown: [],
    },
    businessStatus: 'OPERATIONAL',
    primaryTypeLabel: item.searchCategory || null,
    mapsUrl: `https://www.google.com/maps/search/?api=1&query=Google+Maps&query_place_id=${encodeURIComponent(
      item.placeId
    )}`,
    location: null,
    exclusionMatch: { excluded: false, matchedRule: null },
    confirmedNoWebsite: Boolean(item.confirmedNoWebsite),
    independentPhone: cleanPhone,
    independentEmail: (item.independentEmail || '').trim(),
    independentWebsiteNote: '',
  };
}

/**
 * Agrega uno o más BusinessLead ya cargados en memoria de Explorador a TemporaryLeadQueue.
 * - Reutiliza el objeto en memoria con 0 llamadas a Google Places Details.
 * - Detecta duplicados por placeId.
 * - No exige 4/4 campos independientes para ingresar a la cola de trabajo.
 */
export function addLeadsToTemporaryQueue(
  currentQueue: TemporaryQueueEntry[],
  leadsToAdd: BusinessLead[],
  options?: {
    district?: string;
    category?: string;
    ttlHours?: TemporaryQueueTtlHours;
    initialNotesByPlaceId?: Record<string, string>;
  }
): AddToTemporaryQueueResult {
  const existingIds = new Set(currentQueue.map((e) => e.placeId));
  const nextEntries: TemporaryQueueEntry[] = [];
  const addedPlaceIds: string[] = [];
  let skippedDuplicates = 0;
  const nowIso = new Date().toISOString();
  const ttlHours: TemporaryQueueTtlHours = options?.ttlHours === 12 ? 12 : 24;
  const { expiresAtIso } = computeExpiryIso(nowIso, ttlHours);

  for (const lead of leadsToAdd) {
    if (!lead || !lead.placeId) continue;
    if (existingIds.has(lead.placeId)) {
      skippedDuplicates += 1;
      continue;
    }
    existingIds.add(lead.placeId);
    addedPlaceIds.push(lead.placeId);
    const noteSeed =
      options?.initialNotesByPlaceId?.[lead.placeId] ?? lead.independentWebsiteNote ?? '';

    nextEntries.push({
      placeId: lead.placeId,
      lead,
      addedAt: nowIso,
      updatedAt: nowIso,
      followUpDate: '',
      priorityLabel: 'normal',
      isSelected: false,
      ttlHours,
      expiresAt: expiresAtIso,
      mapsSessionAvailable: true,
      restoredFromPersistence: false,
      searchCategory: (options?.category || lead.category || '').trim(),
      searchDistrict: (options?.district || '').replace(/,?\s*per[uú]$/i, '').trim(),
      outcome: 'pendiente',
      notes: noteSeed.trim(),
      independentData: createEmptyIndependentDraft(lead, {
        district: options?.district,
        category: options?.category,
      }),
    });
  }

  return {
    queue: [...nextEntries, ...currentQueue],
    addedCount: nextEntries.length,
    skippedDuplicates,
    addedPlaceIds,
  };
}

export function removeFromTemporaryQueue(
  currentQueue: TemporaryQueueEntry[],
  placeIdsToRemove: string[]
): TemporaryQueueEntry[] {
  const removeSet = new Set(placeIdsToRemove);
  if (removeSet.size === 0) return currentQueue;
  return currentQueue.filter((entry) => !removeSet.has(entry.placeId));
}

export function clearTemporaryQueue(): TemporaryQueueEntry[] {
  return [];
}

export function updateTemporaryQueueEntry(
  currentQueue: TemporaryQueueEntry[],
  placeId: string,
  patch: Partial<{
    outcome: TemporaryQueueOutcome;
    notes: string;
    followUpDate: string;
    priorityLabel: TemporaryQueuePriority;
    isSelected: boolean;
    ttlHours: TemporaryQueueTtlHours;
    promotedToCrmId: string;
    independentData: Partial<TemporaryQueueIndependentDraft>;
  }>
): TemporaryQueueEntry[] {
  const nowIso = new Date().toISOString();
  return currentQueue.map((entry) => {
    if (entry.placeId !== placeId) return entry;
    const nextTtl = patch.ttlHours ?? entry.ttlHours ?? 24;
    const { expiresAtIso } = computeExpiryIso(nowIso, nextTtl);

    return {
      ...entry,
      updatedAt: nowIso,
      ttlHours: nextTtl,
      expiresAt: expiresAtIso,
      ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.followUpDate !== undefined ? { followUpDate: patch.followUpDate } : {}),
      ...(patch.priorityLabel !== undefined ? { priorityLabel: patch.priorityLabel } : {}),
      ...(patch.isSelected !== undefined ? { isSelected: patch.isSelected } : {}),
      ...(patch.promotedToCrmId !== undefined ? { promotedToCrmId: patch.promotedToCrmId } : {}),
      ...(patch.independentData
        ? {
            independentData: {
              ...entry.independentData,
              ...patch.independentData,
            },
          }
        : {}),
    };
  });
}

/**
 * Re-aplica un TTL (12h o 24h) a toda la cola actual y recalcula expiresAt sin tocar datos de Maps ni CRM definitivo.
 */
export function applyTtlToTemporaryQueue(
  currentQueue: TemporaryQueueEntry[],
  ttlHours: TemporaryQueueTtlHours
): TemporaryQueueEntry[] {
  const nowIso = new Date().toISOString();
  return currentQueue.map((entry) => {
    const baseIso = entry.updatedAt || entry.addedAt || nowIso;
    const { expiresAtIso } = computeExpiryIso(baseIso, ttlHours);
    return {
      ...entry,
      ttlHours,
      expiresAt: expiresAtIso,
    };
  });
}

/**
 * Restaura y fusiona elementos válidos (< 12h/24h) recuperados desde Firestore con la cola viva en memoria:
 * - Descarta automáticamente ítems vencidos (expiresAtEpochMs <= nowMs).
 * - Nunca crea duplicados por placeId.
 * - Conserva datos de Maps en RAM si están presentes en currentQueue o sessionLeads (0 llamadas Places).
 * - Si no hay Maps en RAM, marca mapsSessionAvailable = false y expone íntegros los datos propios autorizados.
 */
export function mergeRestoredTemporaryQueue(
  currentQueue: TemporaryQueueEntry[],
  persistedItems: PersistedTemporaryWorkItem[],
  sessionLeads: BusinessLead[],
  nowMs: number = Date.now()
): {
  mergedQueue: TemporaryQueueEntry[];
  restoredCount: number;
  expiredCount: number;
  missingMapsSessionCount: number;
} {
  const sessionLeadsById = new Map<string, BusinessLead>();
  for (const l of sessionLeads) {
    if (l.placeId) sessionLeadsById.set(l.placeId, l);
  }

  const existingById = new Map<string, TemporaryQueueEntry>();
  for (const entry of currentQueue) {
    existingById.set(entry.placeId, entry);
  }

  let expiredCount = 0;
  let restoredCount = 0;
  let missingMapsSessionCount = 0;

  for (const item of persistedItems) {
    if (!item.placeId) continue;
    if (!Number.isFinite(item.expiresAtEpochMs) || item.expiresAtEpochMs <= nowMs) {
      expiredCount += 1;
      continue;
    }

    const existing = existingById.get(item.placeId);
    const liveLeadFromSearch = sessionLeadsById.get(item.placeId);
    const hasLiveMaps = Boolean(
      (existing && existing.mapsSessionAvailable !== false && existing.lead?.name) ||
        liveLeadFromSearch
    );
    const resolvedLead =
      existing && existing.mapsSessionAvailable !== false && existing.lead?.name
        ? existing.lead
        : liveLeadFromSearch ||
          buildSessionPlaceholderLead({
            placeId: item.placeId,
            searchCategory: item.searchCategory,
            confirmedNoWebsite: item.confirmedNoWebsite,
            independentPhone: item.provenanceConfirmed ? item.independentPhone : '',
            independentEmail: item.provenanceConfirmed ? item.independentEmail : '',
          });

    if (!hasLiveMaps) {
      missingMapsSessionCount += 1;
    }

    const persistedIndependent: TemporaryQueueIndependentDraft = {
      independentBusinessName: item.provenanceConfirmed ? item.independentBusinessName : '',
      independentPhone: item.provenanceConfirmed ? item.independentPhone : '',
      independentAddress: item.provenanceConfirmed ? item.independentAddress : '',
      district: item.district || '',
      independentWebsite: item.provenanceConfirmed ? item.independentWebsite : '',
      independentEmail: item.provenanceConfirmed ? item.independentEmail : '',
      independentCategory: item.independentCategory || item.searchCategory || '',
      confirmedNoWebsite: Boolean(item.confirmedNoWebsite),
      legalBasis: item.legalBasis || '',
      provenanceConfirmed: Boolean(item.provenanceConfirmed),
      independentDataProvenance: item.independentDataProvenance || '',
    };

    const existingUpdatedMs = existing ? Date.parse(existing.updatedAt || existing.addedAt) || 0 : 0;
    const persistedUpdatedMs = Date.parse(item.updatedAt || item.createdAt) || 0;

    if (existing) {
      // Preserva el registro vivo de sesión, y solo rellena campos propios si Firestore es más reciente o estaban vacíos
      const usePersistedFields = persistedUpdatedMs > existingUpdatedMs;
      existingById.set(item.placeId, {
        ...existing,
        lead: resolvedLead,
        mapsSessionAvailable: hasLiveMaps,
        outcome: usePersistedFields ? item.outcome : existing.outcome,
        notes: usePersistedFields
          ? item.notes
          : existing.notes.trim() || item.notes,
        followUpDate: usePersistedFields
          ? item.followUpDate
          : existing.followUpDate || item.followUpDate,
        priorityLabel: usePersistedFields
          ? item.priorityLabel
          : existing.priorityLabel || item.priorityLabel,
        isSelected: usePersistedFields ? item.isSelected : Boolean(existing.isSelected || item.isSelected),
        ttlHours: item.ttlHours,
        expiresAt: new Date(item.expiresAtEpochMs).toISOString(),
        promotedToCrmId: existing.promotedToCrmId || item.promotedToCrmId || undefined,
        independentData: {
          ...persistedIndependent,
          ...existing.independentData,
          independentBusinessName:
            existing.independentData.independentBusinessName.trim() ||
            persistedIndependent.independentBusinessName,
          independentPhone:
            existing.independentData.independentPhone.trim() ||
            persistedIndependent.independentPhone,
          independentAddress:
            existing.independentData.independentAddress.trim() ||
            persistedIndependent.independentAddress,
          independentWebsite:
            existing.independentData.independentWebsite.trim() ||
            persistedIndependent.independentWebsite,
          independentEmail:
            existing.independentData.independentEmail.trim() ||
            persistedIndependent.independentEmail,
          provenanceConfirmed:
            existing.independentData.provenanceConfirmed ||
            persistedIndependent.provenanceConfirmed,
          independentDataProvenance:
            existing.independentData.independentDataProvenance ||
            persistedIndependent.independentDataProvenance,
        },
      });
    } else {
      restoredCount += 1;
      existingById.set(item.placeId, {
        placeId: item.placeId,
        lead: resolvedLead,
        addedAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.updatedAt || item.createdAt,
        followUpDate: item.followUpDate || '',
        priorityLabel: item.priorityLabel || 'normal',
        isSelected: Boolean(item.isSelected),
        ttlHours: item.ttlHours === 12 ? 12 : 24,
        expiresAt: new Date(item.expiresAtEpochMs).toISOString(),
        mapsSessionAvailable: hasLiveMaps,
        restoredFromPersistence: true,
        searchCategory: item.searchCategory || '',
        searchDistrict: item.searchDistrict || '',
        outcome: item.outcome,
        notes: item.notes || '',
        promotedToCrmId: item.promotedToCrmId || undefined,
        independentData: persistedIndependent,
      });
    }
  }

  const mergedQueue = Array.from(existingById.values()).sort((a, b) =>
    (b.updatedAt || b.addedAt).localeCompare(a.updatedAt || a.addedAt)
  );

  return {
    mergedQueue,
    restoredCount,
    expiredCount,
    missingMapsSessionCount,
  };
}

/**
 * Re-vincula automáticamente datos vivos de Maps cuando Explorador carga resultados en memoria RAM
 * que coinciden por placeId con ítems restaurados, con 0 consultas adicionales.
 */
export function reattachSessionLeadsToTemporaryQueue(
  queue: TemporaryQueueEntry[],
  sessionLeads: BusinessLead[]
): TemporaryQueueEntry[] {
  if (queue.length === 0 || sessionLeads.length === 0) return queue;
  const byId = new Map(sessionLeads.map((l) => [l.placeId, l]));
  let changed = false;

  const updated = queue.map((entry) => {
    const match = byId.get(entry.placeId);
    if (!match) return entry;
    if (entry.mapsSessionAvailable !== false && entry.lead.name === match.name) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      lead: match,
      mapsSessionAvailable: true,
    };
  });

  return changed ? updated : queue;
}

/**
 * Indica si existen prospectos con información que se perdería al recargar/cerrar
 * (p. ej. sin sesión Google iniciada o con datos temporales de Maps aún sin datos independientes confirmados).
 */
export function hasUnrecoverableSessionMapsWork(
  queue: TemporaryQueueEntry[],
  isSignedIn: boolean
): boolean {
  if (queue.length === 0) return false;
  if (!isSignedIn) return true;
  return queue.some(
    (entry) =>
      entry.mapsSessionAvailable !== false &&
      Boolean(entry.lead?.name) &&
      (!entry.independentData.provenanceConfirmed ||
        (!entry.independentData.independentBusinessName.trim() &&
          !entry.independentData.independentPhone.trim()))
  );
}

export function filterTemporaryQueue(
  queue: TemporaryQueueEntry[],
  filters: {
    searchText: string;
    outcomeFilter: 'all' | TemporaryQueueOutcome;
  }
): TemporaryQueueEntry[] {
  const q = filters.searchText.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');

  return queue.filter((entry) => {
    if (filters.outcomeFilter !== 'all' && entry.outcome !== filters.outcomeFilter) {
      return false;
    }
    if (!q) return true;

    const sessionName = (entry.lead.name || '').toLowerCase();
    const sessionPhone = (entry.lead.phone || '').toLowerCase();
    const sessionAddress = (entry.lead.address || '').toLowerCase();
    const indName = (entry.independentData.independentBusinessName || '').toLowerCase();
    const indPhone = (entry.independentData.independentPhone || '').toLowerCase();
    const notesLower = (entry.notes || '').toLowerCase();
    const placeIdLower = entry.placeId.toLowerCase();

    if (
      sessionName.includes(q) ||
      sessionPhone.includes(q) ||
      sessionAddress.includes(q) ||
      indName.includes(q) ||
      indPhone.includes(q) ||
      notesLower.includes(q) ||
      placeIdLower.includes(q)
    ) {
      return true;
    }

    if (qDigits.length >= 3) {
      const sDigits = (entry.lead.phone || '').replace(/\D/g, '');
      const iDigits = (entry.independentData.independentPhone || '').replace(/\D/g, '');
      if (sDigits.includes(qDigits) || iDigits.includes(qDigits)) {
        return true;
      }
    }

    return false;
  });
}

export function getTemporaryQueueOutcomeMeta(
  outcome: TemporaryQueueOutcome
): TemporaryQueueOutcomeMeta {
  return (
    TEMPORARY_QUEUE_OUTCOMES.find((o) => o.value === outcome) || TEMPORARY_QUEUE_OUTCOMES[0]
  );
}

export interface FourPhoneConceptsStatus {
  hasValidPhoneFormat: boolean;
  phoneFormatLabel: string;
  isPhoneIndependentlyCorroborated: boolean;
  phoneCorroborationLabel: string;
  hasContactAuthorization: boolean;
  authorizationLabel: string;
  realOutcomeLabel: string;
}

/**
 * FASE 5: Separa claramente los 4 conceptos distintos:
 * 1. formato telefónico válido
 * 2. teléfono corroborado
 * 3. autorización de contacto
 * 4. resultado real
 */
export function evaluateTemporaryEntryFourConcepts(
  entry: TemporaryQueueEntry
): FourPhoneConceptsStatus {
  const indPhone = entry.independentData.independentPhone.trim();
  const mapsPhoneAvailable = entry.mapsSessionAvailable !== false;
  const effectivePhone =
    indPhone ||
    (mapsPhoneAvailable &&
    entry.lead.phone &&
    entry.lead.phone !== 'Sin teléfono' &&
    !entry.lead.phone.startsWith('No disponible tras reinicio')
      ? entry.lead.phone
      : '');

  const parsed = analyzePeruvianPhone(
    effectivePhone,
    indPhone ? 'independently_corroborated' : entry.lead.phoneAnalysis.stage
  );

  const hasValidPhoneFormat = parsed.isValidFormat;
  const phoneFormatLabel = !effectivePhone
    ? mapsPhoneAvailable
      ? 'Sin número registrado'
      : 'Maps no en sesión (requiere nueva búsqueda o dato propio)'
    : parsed.isValidFormat
    ? parsed.lineType === 'mobile'
      ? `Móvil peruano válido (${parsed.formatted})`
      : `Fijo válido (${parsed.formatted})`
    : 'Formato no válido';

  const isPhoneIndependentlyCorroborated = Boolean(
    (indPhone && entry.independentData.provenanceConfirmed) ||
      entry.lead.phoneAnalysis.stage === 'independently_corroborated' ||
      entry.lead.phoneAnalysis.stage === 'contact_reached'
  );
  const phoneCorroborationLabel = isPhoneIndependentlyCorroborated
    ? 'Corroborado independientemente'
    : 'Solo referencia temporal Maps (sin corroborar)';

  const hasContactAuthorization = entry.independentData.legalBasis.trim().length >= 8;
  const authorizationLabel = hasContactAuthorization
    ? 'Con base legal declarada'
    : 'No autorizado automáticamente';

  const realOutcomeLabel = getTemporaryQueueOutcomeMeta(entry.outcome).label;

  return {
    hasValidPhoneFormat,
    phoneFormatLabel,
    isPhoneIndependentlyCorroborated,
    phoneCorroborationLabel,
    hasContactAuthorization,
    authorizationLabel,
    realOutcomeLabel,
  };
}

/**
 * Traduce el resultado propio en la cola temporal hacia el estado/resultado del CRM Definitivo
 * respetando el gate obligatorio de autorización legal.
 */
export function mapTemporaryOutcomeToCrmState(
  outcome: TemporaryQueueOutcome,
  legalBasis: string
): {
  stage: FollowupStage;
  commercialOutcome: CommercialOutcomeType;
} {
  const hasLegalAuth = legalBasis.trim().length >= 8;

  switch (outcome) {
    case 'cliente':
      return {
        stage: hasLegalAuth ? 'CLIENTE' : 'PENDIENTE DE VERIFICACIÓN',
        commercialOutcome: 'venta_confirmada',
      };
    case 'cotizacion':
      return {
        stage: hasLegalAuth ? 'COTIZACIÓN' : 'PENDIENTE DE VERIFICACIÓN',
        commercialOutcome: 'cotizacion_enviada',
      };
    case 'interesado':
      return {
        stage: hasLegalAuth ? 'INTERESADO' : 'PENDIENTE DE VERIFICACIÓN',
        commercialOutcome: 'interesado',
      };
    case 'contacto_alcanzado':
      return {
        stage: hasLegalAuth ? 'CONTACTADO' : 'PENDIENTE DE VERIFICACIÓN',
        commercialOutcome: 'respondio',
      };
    case 'no_interesado':
      return {
        stage: hasLegalAuth ? 'DESCARTADO' : 'PENDIENTE DE VERIFICACIÓN',
        commercialOutcome: 'no_interesado',
      };
    case 'no_responde':
      return {
        stage: hasLegalAuth ? 'CONTACTADO' : 'PENDIENTE DE VERIFICACIÓN',
        commercialOutcome: 'sin_respuesta',
      };
    case 'numero_incorrecto':
      return {
        stage: 'PENDIENTE DE VERIFICACIÓN',
        commercialOutcome: 'datos_incorrectos',
      };
    case 'contacto_no_autorizado':
      return {
        stage: 'PENDIENTE DE VERIFICACIÓN',
        commercialOutcome: 'none',
      };
    case 'descartado':
      return {
        stage: 'DESCARTADO',
        commercialOutcome: 'none',
      };
    case 'pendiente':
    default:
      return {
        stage: hasLegalAuth ? 'CONTACTO AUTORIZADO' : 'PENDIENTE DE VERIFICACIÓN',
        commercialOutcome: 'none',
      };
  }
}
