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
 * Respeta sucursales reales con Place ID distinto.
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
 * Evalúa si un establecimiento cumple con los filtros combinables del Explorador (FASE 4).
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
    if (
      isDiscarded ||
      lead.exclusionMatch.excluded ||
      isClient ||
      isDiscardedInCrm ||
      lead.businessStatus === 'CLOSED_PERMANENTLY'
    ) {
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
 * Clasifica determinísticamente un establecimiento para WEBNEX SYSTEMS (Smart Qualifier 2.0).
 * Evalúa 3 dimensiones independientes (Necesidad Digital, Calidad del Contacto y Confianza de la Información).
 * Nunca inventa probabilidad de compra (%) ni asume WhatsApp o actividad de línea sin corroboración.
 */
export function evaluateLeadQualification(
  lead: BusinessLead,
  ctx: QualificationContext,
  seenPlaceIdsInBatch: Set<string>
): LeadQualificationResult {
  const geminiAnalysis = ctx.geminiAnalysesByPlaceId?.get(lead.placeId) || null;
  const reasons: string[] = [];
  const missingInformation: string[] = [...(lead.trustScore?.missingCoreFields || [])];
  const contradictions: string[] = [...(lead.trustScore?.contradictions || [])];

  if (geminiAnalysis?.contradictions?.length) {
    for (const c of geminiAnalysis.contradictions) {
      if (!contradictions.includes(c)) contradictions.push(c);
    }
  }

  const lineType = lead.phoneAnalysis.lineType;
  const hasMobile = lineType === 'mobile' && lead.phoneAnalysis.isValidFormat;
  const isLandlineOnly = lineType === 'landline_lima' || lineType === 'landline_regional';

  const followupByPlaceId = new Map<string, FollowupLeadRecord>();
  for (const f of ctx.existingFollowups) {
    if (f.placeId) followupByPlaceId.set(f.placeId, f);
  }
  const existingFollowup = followupByPlaceId.get(lead.placeId);
  const alreadyInFollowup = Boolean(existingFollowup);

  const digitalVal = lead.digitalScore.score;
  const contactVal = lead.contactabilityScore.score;
  const trustVal = lead.trustScore?.score ?? 25;
  const isFichaCompleta = Boolean(
    lead.independentPhone.trim() &&
      (lead.independentWebsiteNote.trim() ||
        lead.confirmedNoWebsite ||
        lead.websiteProbe.provenance === 'independent_http')
  );

  const reject = (excludedReason: string): LeadQualificationResult => ({
    placeId: lead.placeId,
    tier: 'NO ELEGIBLE',
    digitalScore: digitalVal,
    contactabilityScore: contactVal,
    trustScore: trustVal,
    combinedPriorityScore: 0,
    isFichaCompleta: false,
    contradictions,
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
    return reject(
      `Coincide con lista de exclusión (${lead.exclusionMatch.matchedRule || 'regla registrada'}).`
    );
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
    return reject('Google Places reporta cierre permanente del establecimiento (CLOSED_PERMANENTLY).');
  }

  if (isLandlineOnly) {
    return reject(
      `Descartado de cola móvil por teléfono fijo (${lead.phoneAnalysis.note}); nunca se convierte automáticamente en celular.`
    );
  }

  if (!hasMobile) {
    if (!missingInformation.includes('Sin celular peruano válido (9 dígitos iniciando en 9).')) {
      missingInformation.push('Sin celular peruano válido (9 dígitos iniciando en 9).');
    }
    return reject(
      lead.phoneAnalysis.lineType === 'invalid'
        ? 'Número registrado con formato no estándar; sin celular peruano válido.'
        : 'Sin teléfono celular peruano registrado en ficha.'
    );
  }

  const webStatus = lead.websiteProbe.status;
  if (webStatus === 'active_https' && !lead.confirmedNoWebsite && digitalVal < 40) {
    reasons.push('Sitio web propio activo con HTTPS verificado sin brechas críticas detectadas.');
    if (geminiAnalysis && geminiAnalysis.digitalNeeds.length > 0) {
      reasons.push(`Observación técnica web: ${geminiAnalysis.digitalNeeds[0]}`);
    }
    return {
      placeId: lead.placeId,
      tier: 'NO ELEGIBLE',
      digitalScore: digitalVal,
      contactabilityScore: contactVal,
      trustScore: trustVal,
      combinedPriorityScore: Math.round(digitalVal * 0.4 + contactVal * 0.35 + trustVal * 0.25),
      isFichaCompleta,
      contradictions,
      reasons,
      missingInformation,
      isLandlineOnly: false,
      hasMobile: true,
      excludedReason: 'Sitio web HTTPS funcional ya operativo sin brecha prioritaria.',
      alreadyInFollowup: false,
      geminiAnalysis,
    };
  }

  // Información pendiente explícita (FASE 2 & 4)
  if (lead.phoneAnalysis.stage === 'registered_valid_format') {
    missingInformation.push(
      'Corroboración independiente de línea activa y autorización legal (WhatsApp no asumido).'
    );
  }
  if (webStatus === 'unregistered' && !lead.confirmedNoWebsite) {
    missingInformation.push(
      'Confirmar manualmente si posee dominio propio ("sin web registrada" ≠ "sin web confirmada").'
    );
  }
  if (webStatus === 'unverified_inconclusive') {
    missingInformation.push(
      `Revisión manual del sitio web (${lead.websiteProbe.inconclusiveReason || 'HTTP inconcluso'}).`
    );
  }
  if (lead.businessStatus === 'CLOSED_TEMPORARILY') {
    missingInformation.push('Verificar si el establecimiento reabrió (reportado CLOSED_TEMPORARILY).');
  }
  if (geminiAnalysis?.missingInformation?.length) {
    for (const m of geminiAnalysis.missingInformation) {
      if (!missingInformation.includes(m)) missingInformation.push(m);
    }
  }

  let tier: QualificationTier = 'REVISIÓN PENDIENTE';

  const hasVerifiedDigitalGap =
    lead.confirmedNoWebsite ||
    webStatus === 'confirmed_none' ||
    webStatus === 'unreachable_verified' ||
    webStatus === 'social_only' ||
    webStatus === 'invalid_url';

  if (
    hasVerifiedDigitalGap &&
    lead.businessStatus !== 'CLOSED_TEMPORARILY' &&
    contradictions.length === 0
  ) {
    tier = 'PRIORIDAD ALTA';
    if (lead.confirmedNoWebsite || webStatus === 'confirmed_none') {
      reasons.push(
        'Ausencia de sitio web propio confirmada manualmente (alta necesidad digital WEBNEX).'
      );
    } else if (webStatus === 'unreachable_verified') {
      reasons.push('Sitio web registrado presenta fallo definitivo verificado (DNS/HTTP inaccesible).');
    } else if (webStatus === 'social_only') {
      reasons.push('Presencia limitada a red social/agregador sin dominio web corporativo propio.');
    } else if (webStatus === 'invalid_url') {
      reasons.push('URL registrada en ficha tiene formato inválido o inutilizable.');
    }
    reasons.push(
      'Celular peruano con formato válido (WhatsApp y vigencia sujetos a corroboración y base legal).'
    );
  } else {
    tier = 'REVISIÓN PENDIENTE';
    if (lead.businessStatus === 'CLOSED_TEMPORARILY') {
      reasons.push('Figura temporalmente cerrado (CLOSED_TEMPORARILY): requiere confirmación operativa.');
    } else if (contradictions.length > 0) {
      reasons.push(`Señales contradictorias detectadas: ${contradictions[0]}`);
    } else if (webStatus === 'unregistered') {
      reasons.push(
        'Sin web registrada en Maps (distinto de ausencia confirmada; requiere verificación independiente).'
      );
    } else if (webStatus === 'unverified_inconclusive') {
      reasons.push(
        lead.websiteProbe.provenance === 'google_absent'
          ? 'URL registrada aún no verificada por HTTP independiente.'
          : `Verificación web inconclusa (${lead.websiteProbe.inconclusiveReason || 'antibots/403/429'}); requiere revisión manual.`
      );
    } else if (webStatus === 'active_http' || webStatus === 'active_https') {
      reasons.push(
        'Sitio web con hallazgos técnicos (ej. sin HTTPS o sin metadatos completos) candidato a modernización.'
      );
    }
    reasons.push('Celular peruano con formato válido disponible para validación previa.');
  }

  if (geminiAnalysis?.commercialRelevance) {
    reasons.push(`Analista Gemini (datos propios): ${geminiAnalysis.commercialRelevance}`);
  }

  const combinedPriorityScore = Math.round(
    digitalVal * 0.45 + contactVal * 0.3 + trustVal * 0.25
  );

  return {
    placeId: lead.placeId,
    tier,
    digitalScore: digitalVal,
    contactabilityScore: contactVal,
    trustScore: trustVal,
    combinedPriorityScore,
    isFichaCompleta,
    contradictions,
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
