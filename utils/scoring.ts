import {
  BusinessLead,
  ContactabilityEvaluation,
  DigitalOpportunityEvaluation,
  FollowupLeadRecord,
  GooglePlaceRaw,
  IndependentFunnelMetrics,
  PeruvianPhoneAnalysis,
  ScoreBreakdownItem,
  WebsiteProbeResult,
} from '../types';

/**
 * Deduplica lugares estrictamente por Google Place ID.
 * Conserva sucursales de una misma marca porque cada sucursal posee un Place ID distinto.
 */
export function deduplicatePlacesById(
  existing: GooglePlaceRaw[],
  incoming: GooglePlaceRaw[]
): GooglePlaceRaw[] {
  const seen = new Set(existing.map((p) => p.placeId));
  const merged = [...existing];
  for (const place of incoming) {
    if (!place.placeId) continue;
    if (!seen.has(place.placeId)) {
      seen.add(place.placeId);
      merged.push(place);
    }
  }
  return merged;
}

/**
 * Puntuación 1: OPORTUNIDAD DIGITAL (0–100)
 * Evalúa exclusivamente brechas digitales/web comprobables.
 * NUNCA usa teléfono, cantidad de reseñas ni calificación de estrellas como señal de compra.
 */
export function computeDigitalOpportunityScore(
  websiteProbe: WebsiteProbeResult,
  confirmedNoWebsite: boolean
): DigitalOpportunityEvaluation {
  const breakdown: ScoreBreakdownItem[] = [];
  const reasons: string[] = [];

  if (confirmedNoWebsite || websiteProbe.status === 'confirmed_none') {
    breakdown.push({
      label: 'Confirmado manualmente que no posee sitio web propio',
      points: 100,
      provenance: 'manual_user',
    });
    reasons.push('Negocio confirmado manualmente sin sitio web propio (oportunidad directa de diseño web).');
    return {
      score: 100,
      label: 'Oportunidad Digital Comprobada',
      isIndependentlyVerified: true,
      reasons,
      breakdown,
    };
  }

  switch (websiteProbe.status) {
    case 'unregistered':
      breakdown.push({
        label: 'Sin sitio web registrado en Google Maps (pendiente confirmación manual)',
        points: 85,
        provenance: 'google_reference',
      });
      reasons.push('No tiene sitio web registrado en su ficha; requiere confirmación manual antes de afirmar ausencia total.');
      return {
        score: 85,
        label: 'Sin web registrada (Por confirmar)',
        isIndependentlyVerified: false,
        reasons,
        breakdown,
      };

    case 'unreachable_verified':
      breakdown.push({
        label: 'Dominio o sitio web inaccesible verificado (DNS/HTTP definitivo)',
        points: 85,
        provenance: 'independent_verified',
      });
      reasons.push(`Sitio web registrado inaccesible tras verificación HTTP independiente (${websiteProbe.summary}).`);
      return {
        score: 85,
        label: 'Web caída verificada',
        isIndependentlyVerified: true,
        reasons,
        breakdown,
      };

    case 'social_only':
      breakdown.push({
        label: 'Enlace apunta únicamente a red social o agregador gratuito',
        points: 70,
        provenance: 'independent_verified',
      });
      reasons.push('Solo registra red social o enlace básico; carece de dominio propio corporativo.');
      return {
        score: 70,
        label: 'Solo red social',
        isIndependentlyVerified: true,
        reasons,
        breakdown,
      };

    case 'invalid_url':
      breakdown.push({
        label: 'URL registrada con sintaxis inválida',
        points: 65,
        provenance: 'independent_verified',
      });
      reasons.push('La URL registrada es inválida o malformada y no dirige a un sitio funcional.');
      return {
        score: 65,
        label: 'URL inválida',
        isIndependentlyVerified: true,
        reasons,
        breakdown,
      };

    case 'active_http':
      breakdown.push({
        label: 'Sitio web propio activo sin cifrado HTTPS',
        points: 50,
        provenance: 'independent_verified',
      });
      reasons.push('El sitio responde por HTTP sin HTTPS válido; candidato para modernización web.');
      return {
        score: 50,
        label: 'Web sin HTTPS',
        isIndependentlyVerified: true,
        reasons,
        breakdown,
      };

    case 'unverified_inconclusive':
      breakdown.push({
        label: 'Verificación HTTP inconclusa (antibots / 403 / 429 / 405 / timeout)',
        points: 40,
        provenance: 'independent_verified',
      });
      reasons.push(`Estado web NO VERIFICADO (${websiteProbe.inconclusiveReason || 'respuesta inconclusa'}); no se asume web caída.`);
      return {
        score: 40,
        label: 'No verificado (Revisión manual)',
        isIndependentlyVerified: false,
        reasons,
        breakdown,
      };

    case 'active_https':
    default:
      breakdown.push({
        label: 'Sitio web propio activo con HTTPS verificado',
        points: 15,
        provenance: 'independent_verified',
      });
      reasons.push('Cuenta con sitio web HTTPS funcional; prioridad baja frente a negocios sin web.');
      return {
        score: 15,
        label: 'Web HTTPS activa',
        isIndependentlyVerified: true,
        reasons,
        breakdown,
      };
  }
}

/**
 * Puntuación 2: CONTACTABILIDAD (0–100)
 * Separada completamente de la oportunidad digital.
 * NUNCA asume intención de compra ni presencia de WhatsApp por tener móvil.
 */
export function computeContactabilityScore(
  googlePhone: PeruvianPhoneAnalysis,
  independentPhone: PeruvianPhoneAnalysis,
  independentEmail: string
): ContactabilityEvaluation {
  const breakdown: ScoreBreakdownItem[] = [];
  const reasons: string[] = [];

  // Prioritize independent phone stage if corroborated or reached
  const bestStage =
    independentPhone.stage === 'contact_reached' || independentPhone.stage === 'independently_corroborated'
      ? independentPhone.stage
      : googlePhone.stage;

  let baseScore = 0;
  let isIndependentlyCorroborated = false;

  switch (bestStage) {
    case 'contact_reached':
      baseScore = 85;
      isIndependentlyCorroborated = true;
      breakdown.push({
        label: 'Contacto realmente alcanzado en canal verificado',
        points: 85,
        provenance: 'manual_user',
      });
      reasons.push('Se estableció contacto efectivo por un canal verificado.');
      break;

    case 'independently_corroborated':
      baseScore = 70;
      isIndependentlyCorroborated = true;
      breakdown.push({
        label: 'Teléfono corroborado independientemente por WEBNEX',
        points: 70,
        provenance: 'manual_user',
      });
      reasons.push('Teléfono corroborado independientemente fuera de Google Maps.');
      break;

    case 'registered_valid_format':
      baseScore = 45;
      breakdown.push({
        label: 'Teléfono registrado en Google con formato peruano válido',
        points: 45,
        provenance: 'google_reference',
      });
      reasons.push('Número con formato peruano válido en ficha de Google (pendiente corroboración independiente; WhatsApp no asumido).');
      break;

    case 'registered_invalid':
      baseScore = 20;
      breakdown.push({
        label: 'Teléfono registrado con formato no estándar',
        points: 20,
        provenance: 'google_reference',
      });
      reasons.push('Teléfono registrado requiere corrección o validación manual.');
      break;

    case 'none':
    default:
      breakdown.push({
        label: 'Sin teléfono registrado ni corroborado',
        points: 0,
        provenance: 'google_reference',
      });
      reasons.push('Sin canal telefónico disponible.');
      break;
  }

  const trimmedEmail = (independentEmail || '').trim();
  if (trimmedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    baseScore = Math.min(100, baseScore + 15);
    isIndependentlyCorroborated = true;
    breakdown.push({
      label: 'Correo comercial obtenido independientemente',
      points: 15,
      provenance: 'manual_user',
    });
    reasons.push('Cuenta con correo corporativo capturado independientemente.');
  }

  const label =
    baseScore >= 80
      ? 'Contactabilidad verificada'
      : baseScore >= 45
      ? 'Contactable (Por corroborar)'
      : baseScore > 0
      ? 'Contactabilidad limitada'
      : 'Sin canal de contacto';

  return {
    score: baseScore,
    label,
    isIndependentlyCorroborated,
    reasons,
    breakdown,
  };
}

/**
 * Calcula métricas independientes del cualificador y embudo comercial sin inventar tasas de conversión.
 */
export function computeIndependentFunnelMetrics(
  sessionLeads: BusinessLead[],
  followups: FollowupLeadRecord[],
  extras?: {
    discardedPlaceIdsCount?: number;
  }
): IndependentFunnelMetrics {
  const uniquePlaceIds = new Set(sessionLeads.map((l) => l.placeId));

  let discardedLandlineCount = 0;
  let noMobileCount = 0;
  let excludedOrDiscardedInSession = 0;

  for (const lead of sessionLeads) {
    const lt = lead.phoneAnalysis.lineType;
    if (lt === 'landline_lima' || lt === 'landline_regional') {
      discardedLandlineCount++;
    }
    if (lt !== 'mobile' || !lead.phoneAnalysis.isValidFormat) {
      noMobileCount++;
    }
    if (lead.exclusionMatch.excluded) {
      excludedOrDiscardedInSession++;
    }
  }

  const corroboratedRecords = followups.filter(
    (f) =>
      (f.stage !== 'PRESELECCIONADO' && f.stage !== 'PENDIENTE DE VERIFICACIÓN') ||
      f.phoneStage === 'independently_corroborated' ||
      f.phoneStage === 'contact_reached' ||
      f.confirmedNoWebsite
  ).length;

  const verifiableDigitalOpportunities = followups.filter(
    (f) =>
      f.stage !== 'DESCARTADO' &&
      (f.confirmedNoWebsite ||
        f.independentWebsiteStatus === 'unreachable_verified' ||
        f.independentWebsiteStatus === 'social_only' ||
        f.independentWebsiteStatus === 'active_http' ||
        f.independentWebsiteStatus === 'invalid_url')
  ).length;

  const preselectedCount = followups.filter((f) => f.stage === 'PRESELECCIONADO').length;

  const pendingCorroborationCount = followups.filter(
    (f) =>
      f.stage === 'PRESELECCIONADO' ||
      f.stage === 'PENDIENTE DE VERIFICACIÓN' ||
      f.independentWebsiteStatus === 'unverified_inconclusive' ||
      (f.independentWebsiteStatus === 'unregistered' && !f.confirmedNoWebsite)
  ).length;

  const authorizedStageSet = new Set([
    'CONTACTO AUTORIZADO',
    'CONTACTADO',
    'RESPONDIÓ',
    'INTERESADO',
    'COTIZACIÓN',
    'CLIENTE',
  ]);
  const contactedStages = new Set([
    'CONTACTADO',
    'RESPONDIÓ',
    'INTERESADO',
    'COTIZACIÓN',
    'CLIENTE',
  ]);
  const responseStages = new Set(['RESPONDIÓ', 'INTERESADO', 'COTIZACIÓN', 'CLIENTE']);
  const qualifiedStages = new Set(['INTERESADO', 'COTIZACIÓN']);

  const authorizedContactsCount = followups.filter(
    (f) => authorizedStageSet.has(f.stage) && (f.legalBasis || '').trim().length >= 8
  ).length;
  const authorizedContactsMade = followups.filter((f) => contactedStages.has(f.stage)).length;
  const responsesReceived = followups.filter((f) => responseStages.has(f.stage)).length;
  const qualifiedOpportunities = followups.filter((f) => qualifiedStages.has(f.stage)).length;
  const confirmedSales = followups.filter((f) => f.stage === 'CLIENTE').length;

  return {
    uniqueBusinessesFound: uniquePlaceIds.size,
    discardedLandlineCount,
    noMobileCount,
    corroboratedRecords,
    verifiableDigitalOpportunities,
    pendingCorroborationCount,
    preselectedCount,
    duplicatesAndExcludedCount:
      excludedOrDiscardedInSession + (extras?.discardedPlaceIdsCount || 0),
    authorizedContactsCount,
    authorizedContactsMade,
    responsesReceived,
    qualifiedOpportunities,
    confirmedSales,
  };
}
