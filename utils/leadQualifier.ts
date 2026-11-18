import {
  AUTHORIZED_OUTREACH_STAGES,
  BusinessLead,
  FollowupLeadRecord,
  GeminiComplementaryAnalysis,
  LeadQualificationResult,
  QualificationTier,
  QualifierBatchSummary,
  SmartFilterState,
} from '../types';

export interface QualificationContext {
  discardedPlaceIds: Set<string>;
  existingFollowups: FollowupLeadRecord[];
  geminiAnalysesByPlaceId?: Map<string, GeminiComplementaryAnalysis>;
}

/**
 * Normaliza un teléfono para detectar duplicados intra-sesión o en CRM sin asumir WhatsApp.
 */
export function getNormalizedE164ForMatch(lead: BusinessLead): string | null {
  return lead.phoneAnalysis.e164 || null;
}

/**
 * Construye conjuntos de Place IDs ya registrados en CRM, clientes confirmados y duplicados en sesión.
 */
export function buildCrmAndDuplicateSets(
  leads: BusinessLead[],
  existingFollowups: FollowupLeadRecord[]
) {
  const followupByPlaceId = new Map<string, FollowupLeadRecord>();
  const clientPlaceIds = new Set<string>();

  for (const f of existingFollowups) {
    if (f.placeId) {
      followupByPlaceId.set(f.placeId, f);
      if (f.stage === 'CLIENTE') {
        clientPlaceIds.add(f.placeId);
      }
    }
  }

  // Deduplicación estricta por Place ID: detecta si hubiera repetidos y también teléfonos repetidos secundarios
  const seenPlaceIds = new Set<string>();
  const duplicatePlaceIds = new Set<string>();

  for (const lead of leads) {
    if (seenPlaceIds.has(lead.placeId)) {
      duplicatePlaceIds.add(lead.placeId);
    } else {
      seenPlaceIds.add(lead.placeId);
    }
  }

  return {
    followupByPlaceId,
    clientPlaceIds,
    duplicatePlaceIds,
  };
}

/**
 * Evalúa si un establecimiento cumple con los filtros combinables del Explorador.
 */
export function matchesSmartFilters(
  lead: BusinessLead,
  filters: SmartFilterState,
  ctx: {
    discardedPlaceIds: Set<string>;
    followupByPlaceId: Map<string, FollowupLeadRecord>;
    showExcludedAndDiscarded: boolean;
  }
): boolean {
  const isDiscarded = ctx.discardedPlaceIds.has(lead.placeId);
  const existingFollowup = ctx.followupByPlaceId.get(lead.placeId);
  const isClient = existingFollowup?.stage === 'CLIENTE';
  const isDiscardedInCrm = existingFollowup?.stage === 'DESCARTADO';

  if (filters.excludeClientsDiscardsDuplicates) {
    if (isDiscarded || lead.exclusionMatch.excluded || isClient || isDiscardedInCrm) {
      return false;
    }
  } else if (!ctx.showExcludedAndDiscarded && (isDiscarded || lead.exclusionMatch.excluded)) {
    return false;
  }

  const lineType = lead.phoneAnalysis.lineType;
  const isValidMobile = lineType === 'mobile' && lead.phoneAnalysis.isValidFormat;
  const isLandline = lineType === 'landline_lima' || lineType === 'landline_regional';

  if (filters.mobileOnly && !isValidMobile) {
    return false;
  }

  if (filters.excludeLandlines && isLandline) {
    return false;
  }

  if (filters.mobileAndNoWebsite) {
    const hasNoRegisteredWeb =
      lead.websiteProbe.status === 'unregistered' ||
      lead.websiteProbe.status === 'confirmed_none' ||
      lead.confirmedNoWebsite;
    if (!isValidMobile || !hasNoRegisteredWeb) {
      return false;
    }
  }

  if (filters.socialOnly && lead.websiteProbe.status !== 'social_only') {
    return false;
  }

  if (filters.corroboratedWebFailure) {
    const hasWebFailure =
      lead.websiteProbe.status === 'unreachable_verified' ||
      lead.websiteProbe.status === 'invalid_url' ||
      lead.websiteProbe.status === 'active_http';
    if (!hasWebFailure) {
      return false;
    }
  }

  if (filters.pendingVerification) {
    const isWebPending =
      lead.websiteProbe.status === 'unverified_inconclusive' ||
      (Boolean(lead.website) && lead.websiteProbe.provenance === 'google_absent') ||
      (lead.websiteProbe.status === 'unregistered' && !lead.confirmedNoWebsite);
    if (!isWebPending) {
      return false;
    }
  }

  return true;
}

/**
 * Clasifica determinísticamente un establecimiento para WEBNEX SYSTEMS.
 * Separa Oportunidad Digital de Contactabilidad. Nunca inventa probabilidad de compra ni WhatsApp.
 */
export function evaluateLeadQualification(
  lead: BusinessLead,
  ctx: QualificationContext,
  seenPlaceIdsInBatch: Set<string>
): LeadQualificationResult {
  const geminiAnalysis = ctx.geminiAnalysesByPlaceId?.get(lead.placeId) || null;
  const reasons: string[] = [];
  const missingInformation: string[] = [];

  const lineType = lead.phoneAnalysis.lineType;
  const hasMobile = lineType === 'mobile' && lead.phoneAnalysis.isValidFormat;
  const isLandlineOnly = lineType === 'landline_lima' || lineType === 'landline_regional';

  const followupByPlaceId = new Map<string, FollowupLeadRecord>();
  for (const f of ctx.existingFollowups) {
    if (f.placeId) followupByPlaceId.set(f.placeId, f);
  }
  const existingFollowup = followupByPlaceId.get(lead.placeId);
  const alreadyInFollowup = Boolean(existingFollowup);

  const reject = (excludedReason: string): LeadQualificationResult => ({
    placeId: lead.placeId,
    tier: 'NO ELEGIBLE',
    digitalScore: lead.digitalScore.score,
    contactabilityScore: lead.contactabilityScore.score,
    reasons: [excludedReason],
    missingInformation,
    isLandlineOnly,
    hasMobile,
    excludedReason,
    alreadyInFollowup,
    geminiAnalysis,
  });

  if (seenPlaceIdsInBatch.has(lead.placeId)) {
    return reject('Place ID duplicado en el lote evaluado.');
  }

  if (lead.exclusionMatch.excluded) {
    return reject(`Coincide con lista de exclusión (${lead.exclusionMatch.matchedRule || 'regla registrada'}).`);
  }

  if (ctx.discardedPlaceIds.has(lead.placeId)) {
    return reject('Marcado previamente como descartado por el usuario.');
  }

  if (existingFollowup) {
    if (existingFollowup.stage === 'CLIENTE') {
      return reject('Ya registrado en seguimiento como CLIENTE actual.');
    }
    if (existingFollowup.stage === 'DESCARTADO') {
      return reject('Ya registrado en seguimiento con estado DESCARTADO.');
    }
    return reject(`Ya existe en Seguimiento CRM (etapa: ${existingFollowup.stage}); no se duplica.`);
  }

  if (lead.businessStatus === 'CLOSED_PERMANENTLY') {
    return reject('Google Places reporta cierre permanente del establecimiento.');
  }

  if (isLandlineOnly) {
    return reject(
      `Descartado por teléfono fijo (${lead.phoneAnalysis.note}); no registra celular peruano y nunca se convierte automáticamente en móvil.`
    );
  }

  if (!hasMobile) {
    missingInformation.push('Sin celular peruano válido (9 dígitos iniciando en 9).');
    return reject(
      lead.phoneAnalysis.lineType === 'invalid'
        ? 'Número registrado con formato no estándar; sin celular peruano válido.'
        : 'Sin teléfono celular peruano registrado en ficha.'
    );
  }

  // En este punto tiene celular peruano con formato válido (WhatsApp no asumido).
  const webStatus = lead.websiteProbe.status;
  if (webStatus === 'active_https' && !lead.confirmedNoWebsite) {
    reasons.push('Sitio web propio activo con HTTPS verificado (oportunidad digital baja).');
    if (geminiAnalysis && geminiAnalysis.digitalNeeds.length > 0) {
      reasons.push(`Observación técnica web: ${geminiAnalysis.digitalNeeds[0]}`);
    }
    return {
      placeId: lead.placeId,
      tier: 'NO ELEGIBLE',
      digitalScore: lead.digitalScore.score,
      contactabilityScore: lead.contactabilityScore.score,
      reasons,
      missingInformation,
      isLandlineOnly: false,
      hasMobile: true,
      excludedReason: 'Sitio web HTTPS funcional ya operativo.',
      alreadyInFollowup: false,
      geminiAnalysis,
    };
  }

  // Evaluar información faltante explícitamente
  if (lead.phoneAnalysis.stage === 'registered_valid_format') {
    missingInformation.push('Corroboración independiente de que el móvil esté activo y tenga autorización.');
  }
  if (webStatus === 'unregistered' && !lead.confirmedNoWebsite) {
    missingInformation.push('Confirmar manualmente que no posee dominio propio fuera de Google Maps.');
  }
  if (webStatus === 'unverified_inconclusive') {
    missingInformation.push(
      `Revisión manual del sitio web (${lead.websiteProbe.inconclusiveReason || 'HTTP inconcluso'}).`
    );
  }
  if (geminiAnalysis?.missingInformation?.length) {
    for (const m of geminiAnalysis.missingInformation) {
      if (!missingInformation.includes(m)) missingInformation.push(m);
    }
  }

  // Clasificación entre PRIORIDAD ALTA y REVISIÓN PENDIENTE
  let tier: QualificationTier = 'REVISIÓN PENDIENTE';

  if (
    lead.confirmedNoWebsite ||
    webStatus === 'confirmed_none' ||
    webStatus === 'unreachable_verified' ||
    webStatus === 'social_only' ||
    webStatus === 'invalid_url'
  ) {
    tier = 'PRIORIDAD ALTA';
    if (lead.confirmedNoWebsite || webStatus === 'confirmed_none') {
      reasons.push('Ausencia de sitio web propio confirmada manualmente (alta oportunidad para diseño web WEBNEX).');
    } else if (webStatus === 'unreachable_verified') {
      reasons.push('Sitio web registrado presenta fallo definitivo verificado (DNS/HTTP inaccesible).');
    } else if (webStatus === 'social_only') {
      reasons.push('Presencia limitada a red social/agregador sin dominio web corporativo propio.');
    } else if (webStatus === 'invalid_url') {
      reasons.push('URL registrada en ficha tiene formato inválido o inutilizable.');
    }
    reasons.push('Cuenta con celular peruano de formato válido (WhatsApp no asumido; contacto sujeto a base legal/consentimiento).');
  } else {
    // unregistered, unverified_inconclusive, active_http -> REVISIÓN PENDIENTE
    tier = 'REVISIÓN PENDIENTE';
    if (webStatus === 'unregistered') {
      reasons.push('Sin web registrada en Google Maps (distinto de ausencia comprobada; requiere verificación rápida).');
    } else if (webStatus === 'unverified_inconclusive') {
      reasons.push(
        lead.websiteProbe.provenance === 'google_absent'
          ? 'URL registrada en Maps aún no verificada por HTTP independiente.'
          : `Verificación web inconclusa (${lead.websiteProbe.inconclusiveReason || 'antibots/403/429'}); requiere revisión manual.`
      );
    } else if (webStatus === 'active_http') {
      reasons.push('Sitio web responde sin HTTPS; candidato a evaluación de modernización y certificado SSL.');
    }
    reasons.push('Celular peruano con formato válido disponible para validación previa.');
  }

  if (geminiAnalysis?.commercialRelevance) {
    reasons.push(`Análisis técnico web (Gemini): ${geminiAnalysis.commercialRelevance}`);
  }

  return {
    placeId: lead.placeId,
    tier,
    digitalScore: lead.digitalScore.score,
    contactabilityScore: lead.contactabilityScore.score,
    reasons,
    missingInformation,
    isLandlineOnly: false,
    hasMobile: true,
    excludedReason: null,
    alreadyInFollowup: false,
    geminiAnalysis,
  };
}

/**
 * Ejecuta la calificación automática sobre TODOS los resultados cargados en la sesión,
 * independientemente de la página visual de la tabla.
 */
export function qualifyLoadedLeadsBatch(
  allLoadedLeads: BusinessLead[],
  ctx: QualificationContext
): {
  results: LeadQualificationResult[];
  summary: QualifierBatchSummary;
} {
  const seenPlaceIds = new Set<string>();
  const results: LeadQualificationResult[] = [];

  let highPriorityCount = 0;
  let pendingReviewCount = 0;
  let notEligibleCount = 0;
  let discardedLandlineCount = 0;
  let noMobileCount = 0;
  let duplicatesAndExcludedCount = 0;
  let alreadyInCrmSkippedCount = 0;

  for (const lead of allLoadedLeads) {
    const res = evaluateLeadQualification(lead, ctx, seenPlaceIds);
    const wasDuplicate = seenPlaceIds.has(lead.placeId);
    seenPlaceIds.add(lead.placeId);
    results.push(res);

    if (res.tier === 'PRIORIDAD ALTA') highPriorityCount++;
    else if (res.tier === 'REVISIÓN PENDIENTE') pendingReviewCount++;
    else notEligibleCount++;

    if (res.isLandlineOnly && !res.hasMobile) discardedLandlineCount++;
    if (!res.hasMobile) noMobileCount++;
    if (
      wasDuplicate ||
      lead.exclusionMatch.excluded ||
      ctx.discardedPlaceIds.has(lead.placeId)
    ) {
      duplicatesAndExcludedCount++;
    }
    if (res.alreadyInFollowup) {
      alreadyInCrmSkippedCount++;
    }
  }

  return {
    results,
    summary: {
      totalEvaluated: results.length,
      highPriorityCount,
      pendingReviewCount,
      notEligibleCount,
      discardedLandlineCount,
      noMobileCount,
      duplicatesAndExcludedCount,
      alreadyInCrmSkippedCount,
    },
  };
}

export function validateLegalBasisForStage(stage: string, legalBasis: string): string | null {
  if (AUTHORIZED_OUTREACH_STAGES.has(stage as any)) {
    const trimmed = (legalBasis || '').trim();
    if (trimmed.length < 8) {
      return `Para avanzar a "${stage}" debes registrar evidencia verificable de consentimiento o base legal aplicable (mínimo 8 caracteres). La preselección automática no autoriza llamadas comerciales.`;
    }
  }
  return null;
}
