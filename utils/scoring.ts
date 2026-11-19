import {
  AUTHORIZED_OUTREACH_STAGES,
  BusinessLead,
  CommercialOutcomeType,
  ContactabilityEvaluation,
  DigitalOpportunityEvaluation,
  FollowupLeadRecord,
  GooglePlaceRaw,
  IndependentFunnelMetrics,
  InformationTrustEvaluation,
  OutcomeCalibrationStats,
  PeruvianPhoneAnalysis,
  ScoreBreakdownItem,
  WebsiteProbeResult,
} from '../types';
import { evaluateFollowupCompleteness } from './fieldCompliance';

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

const WEBNEX_HIGH_FIT_CATEGORY_KEYWORDS = [
  'clinica',
  'clínica',
  'dental',
  'odontolog',
  'veterinar',
  'estetica',
  'estética',
  'spa',
  'restaurante',
  'hotel',
  'inmobiliaria',
  'constructora',
  'abogado',
  'estudio',
  'contable',
  'ferreteria',
  'ferretería',
  'optica',
  'óptica',
  'colegio',
  'academia',
  'gimnasio',
  'taller',
];

export interface DigitalScoreOptions {
  category?: string;
  technicalEvidence?: {
    hasViewportMeta?: boolean;
    hasMetaDescription?: boolean;
    cmsHint?: string | null;
  };
}

/**
 * Puntaje A: NECESIDAD DIGITAL (0–100)
 * Evalúa exclusivamente brechas digitales/web comprobables y encaje con servicios WEBNEX.
 * NUNCA usa teléfono, cantidad de reseñas ni calificación de estrellas como señal de compra.
 */
export function computeDigitalOpportunityScore(
  websiteProbe: WebsiteProbeResult,
  confirmedNoWebsite: boolean,
  options?: DigitalScoreOptions
): DigitalOpportunityEvaluation {
  const breakdown: ScoreBreakdownItem[] = [];
  const reasons: string[] = [];

  const categoryLower = (options?.category || '').toLowerCase();
  const hasStrongCategoryFit = WEBNEX_HIGH_FIT_CATEGORY_KEYWORDS.some((kw) =>
    categoryLower.includes(kw)
  );

  if (confirmedNoWebsite || websiteProbe.status === 'confirmed_none') {
    breakdown.push({
      label: 'Confirmado manualmente que no posee sitio web propio',
      points: 100,
      provenance: 'manual_user',
    });
    reasons.push(
      'Negocio confirmado manualmente sin sitio web propio (oportunidad directa de diseño web WEBNEX).'
    );
    if (hasStrongCategoryFit) {
      reasons.push(`Rubro (${options?.category}) con necesidad clara de captación y presencia digital.`);
    }
    return {
      score: 100,
      label: 'Oportunidad Digital Comprobada',
      isIndependentlyVerified: true,
      reasons,
      breakdown,
    };
  }

  let result: DigitalOpportunityEvaluation;

  switch (websiteProbe.status) {
    case 'unregistered':
      breakdown.push({
        label: 'Sin sitio web registrado en Google Maps (distinto de ausencia confirmada)',
        points: 85,
        provenance: 'google_reference',
      });
      reasons.push(
        'No tiene sitio web registrado en Maps; requiere confirmación independiente antes de afirmar ausencia total.'
      );
      result = {
        score: 85,
        label: 'Sin web registrada (Por confirmar)',
        isIndependentlyVerified: false,
        reasons,
        breakdown,
      };
      break;

    case 'unreachable_verified':
      breakdown.push({
        label: 'Dominio o sitio web inaccesible verificado (DNS/HTTP definitivo)',
        points: 85,
        provenance: 'independent_verified',
      });
      reasons.push(
        `Sitio web registrado inaccesible tras verificación HTTP independiente (${websiteProbe.summary}).`
      );
      result = {
        score: 85,
        label: 'Web caída verificada',
        isIndependentlyVerified: true,
        reasons,
        breakdown,
      };
      break;

    case 'social_only':
      breakdown.push({
        label: 'Enlace apunta únicamente a red social o agregador gratuito',
        points: 70,
        provenance: 'independent_verified',
      });
      reasons.push('Solo registra red social o enlace básico; carece de dominio propio corporativo.');
      result = {
        score: 70,
        label: 'Solo red social',
        isIndependentlyVerified: true,
        reasons,
        breakdown,
      };
      break;

    case 'invalid_url':
      breakdown.push({
        label: 'URL registrada con sintaxis inválida',
        points: 65,
        provenance: 'independent_verified',
      });
      reasons.push('La URL registrada es inválida o malformada y no dirige a un sitio funcional.');
      result = {
        score: 65,
        label: 'URL inválida',
        isIndependentlyVerified: true,
        reasons,
        breakdown,
      };
      break;

    case 'active_http': {
      let score = 50;
      breakdown.push({
        label: 'Sitio web propio activo sin cifrado HTTPS',
        points: 50,
        provenance: 'independent_verified',
      });
      reasons.push('El sitio responde por HTTP sin HTTPS válido; candidato para modernización web.');
      if (options?.technicalEvidence?.hasViewportMeta === false) {
        score = Math.min(100, score + 15);
        breakdown.push({
          label: 'Sin meta viewport móvil detectada en HTML',
          points: 15,
          provenance: 'independent_verified',
        });
        reasons.push('Evidencia técnica: carece de etiqueta viewport adaptable a móviles.');
      }
      if (options?.technicalEvidence?.hasMetaDescription === false) {
        score = Math.min(100, score + 10);
        breakdown.push({
          label: 'Sin meta description SEO básica',
          points: 10,
          provenance: 'independent_verified',
        });
        reasons.push('Evidencia técnica: ausencia de meta description SEO.');
      }
      result = {
        score,
        label: score >= 65 ? 'Web sin HTTPS / Desactualizada' : 'Web sin HTTPS',
        isIndependentlyVerified: true,
        reasons,
        breakdown,
      };
      break;
    }

    case 'unverified_inconclusive':
      breakdown.push({
        label: 'Verificación HTTP inconclusa (antibots / 403 / 429 / 405 / timeout)',
        points: 40,
        provenance: 'independent_verified',
      });
      reasons.push(
        `Estado web NO VERIFICADO (${websiteProbe.inconclusiveReason || 'respuesta inconclusa'}); no se asume web caída.`
      );
      result = {
        score: 40,
        label: 'No verificado (Revisión manual)',
        isIndependentlyVerified: false,
        reasons,
        breakdown,
      };
      break;

    case 'active_https':
    default: {
      let score = 15;
      breakdown.push({
        label: 'Sitio web propio activo con HTTPS verificado',
        points: 15,
        provenance: 'independent_verified',
      });
      reasons.push('Cuenta con sitio web HTTPS funcional.');
      if (options?.technicalEvidence?.hasViewportMeta === false) {
        score = Math.min(100, score + 20);
        breakdown.push({
          label: 'HTTPS activo pero sin meta viewport móvil en HTML',
          points: 20,
          provenance: 'independent_verified',
        });
        reasons.push('Evidencia HTML: sitio HTTPS carece de adaptación viewport móvil.');
      }
      if (options?.technicalEvidence?.hasMetaDescription === false) {
        score = Math.min(100, score + 10);
        breakdown.push({
          label: 'HTTPS activo sin meta description SEO',
          points: 10,
          provenance: 'independent_verified',
        });
        reasons.push('Evidencia HTML: sin meta description SEO en página principal.');
      }
      if (
        options?.technicalEvidence?.cmsHint &&
        /wix|blogger/i.test(options.technicalEvidence.cmsHint)
      ) {
        score = Math.min(100, score + 10);
        breakdown.push({
          label: `Construido en plantilla gratuita/básica (${options.technicalEvidence.cmsHint})`,
          points: 10,
          provenance: 'independent_verified',
        });
        reasons.push(`Tecnología observada: ${options.technicalEvidence.cmsHint} (candidato a rediseño profesional).`);
      }
      result = {
        score,
        label: score >= 40 ? 'Web HTTPS con mejoras técnicas' : 'Web HTTPS activa',
        isIndependentlyVerified: true,
        reasons,
        breakdown,
      };
      break;
    }
  }

  if (hasStrongCategoryFit && result.score >= 50) {
    result.reasons.push(
      `Rubro (${options?.category}) con alta afinidad para servicios web/reservas de WEBNEX.`
    );
  }

  return result;
}

export interface ContactQualityOptions {
  legalBasis?: string;
  commercialOutcome?: CommercialOutcomeType;
}

/**
 * Puntaje B: CALIDAD DEL CONTACTO (0–100)
 * Separada completamente de la necesidad digital.
 * Penaliza fijos y resultados negativos; NUNCA asume intención de compra ni presencia de WhatsApp por tener móvil.
 */
export function computeContactabilityScore(
  googlePhone: PeruvianPhoneAnalysis,
  independentPhone: PeruvianPhoneAnalysis,
  independentEmail: string,
  options?: ContactQualityOptions
): ContactabilityEvaluation {
  const breakdown: ScoreBreakdownItem[] = [];
  const reasons: string[] = [];

  const hasIndependentPhone = Boolean((independentPhone.raw || '').trim());
  const effectivePhone =
    independentPhone.stage === 'contact_reached' ||
    independentPhone.stage === 'independently_corroborated' ||
    hasIndependentPhone
      ? independentPhone
      : googlePhone;

  const isLandline =
    effectivePhone.lineType === 'landline_lima' || effectivePhone.lineType === 'landline_regional';

  const bestStage =
    independentPhone.stage === 'contact_reached' || independentPhone.stage === 'independently_corroborated'
      ? independentPhone.stage
      : googlePhone.stage;

  let baseScore = 0;
  let isIndependentlyCorroborated = false;

  switch (bestStage) {
    case 'contact_reached':
      baseScore = isLandline ? 40 : 85;
      isIndependentlyCorroborated = true;
      breakdown.push({
        label: isLandline
          ? 'Contacto alcanzado solo por línea fija'
          : 'Contacto móvil realmente alcanzado en canal verificado',
        points: baseScore,
        provenance: 'manual_user',
      });
      reasons.push(
        isLandline
          ? 'Solo registra teléfono fijo (penalizado para cola de contacto móvil).'
          : 'Se estableció contacto efectivo por un canal verificado.'
      );
      break;

    case 'independently_corroborated':
      baseScore = isLandline ? 30 : 70;
      isIndependentlyCorroborated = true;
      breakdown.push({
        label: isLandline
          ? 'Teléfono fijo corroborado (penalizado frente a celular)'
          : 'Celular peruano corroborado independientemente por WEBNEX',
        points: baseScore,
        provenance: 'manual_user',
      });
      reasons.push(
        isLandline
          ? 'Solo se corroboró teléfono fijo; no sustituye a un celular peruano.'
          : 'Teléfono celular corroborado independientemente fuera de Google Maps.'
      );
      break;

    case 'registered_valid_format':
      baseScore = isLandline ? 20 : 45;
      breakdown.push({
        label: isLandline
          ? 'Solo teléfono fijo registrado (penalizado para cola móvil)'
          : 'Celular con formato peruano válido en ficha de referencia',
        points: baseScore,
        provenance: 'google_reference',
      });
      reasons.push(
        isLandline
          ? 'Teléfono fijo peruano: excluido de cola móvil; no se convierte en celular.'
          : 'Celular con formato peruano válido (WhatsApp/actividad no asumidos sin corroboración).'
      );
      break;

    case 'registered_invalid':
      baseScore = 10;
      breakdown.push({
        label: 'Teléfono registrado con formato inválido o incompleto',
        points: 10,
        provenance: 'google_reference',
      });
      reasons.push('Teléfono registrado no cumple formato peruano estándar.');
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

  if (options?.legalBasis && options.legalBasis.trim().length >= 8) {
    baseScore = Math.min(100, baseScore + 10);
    breakdown.push({
      label: 'Autorización o base legal registrada',
      points: 10,
      provenance: 'manual_user',
    });
    reasons.push('Posee evidencia de base legal / consentimiento para contacto.');
  }

  const outcome = options?.commercialOutcome;
  if (
    outcome === 'numero_inexistente' ||
    outcome === 'datos_incorrectos' ||
    outcome === 'no_corresponde' ||
    outcome === 'no_volver_a_contactar'
  ) {
    baseScore = Math.max(0, baseScore - 50);
    breakdown.push({
      label: `Penalización por resultado real negativo (${outcome})`,
      points: -50,
      provenance: 'manual_user',
    });
    reasons.push(`Resultado comercial previo negativo (${outcome}): requiere corrección o exclusión.`);
  } else if (
    outcome === 'respondio' ||
    outcome === 'interesado' ||
    outcome === 'cotizacion_enviada' ||
    outcome === 'venta_confirmada'
  ) {
    baseScore = Math.max(baseScore, 90);
    isIndependentlyCorroborated = true;
    breakdown.push({
      label: `Canal validado por respuesta real (${outcome})`,
      points: 10,
      provenance: 'manual_user',
    });
  }

  const label =
    baseScore >= 80
      ? 'Contacto verificado / Alta calidad'
      : baseScore >= 45
      ? 'Contactable (Por corroborar)'
      : baseScore > 0
      ? 'Calidad de contacto limitada'
      : 'Sin canal de contacto';

  return {
    score: Math.max(0, Math.min(100, baseScore)),
    label,
    isIndependentlyCorroborated,
    reasons,
    breakdown,
  };
}

export interface TrustScoreInput {
  businessStatus: string | null;
  independentBusinessName?: string;
  independentPhone?: string;
  independentAddress?: string;
  district?: string;
  independentWebsite?: string;
  confirmedNoWebsite?: boolean;
  independentCategory?: string;
  websiteProbe: WebsiteProbeResult;
  verificationSourcesCount?: number;
  lastVerifiedAt?: string;
  commercialOutcome?: CommercialOutcomeType;
}

/**
 * Puntaje C: CONFIANZA DE LA INFORMACIÓN (0–100)
 * Evalúa concordancia entre fuentes independientes, estado operativo, frescura,
 * identidad comercial clara y detecta contradicciones o datos insuficientes.
 */
export function computeInformationTrustScore(input: TrustScoreInput): InformationTrustEvaluation {
  const breakdown: ScoreBreakdownItem[] = [];
  const reasons: string[] = [];
  const contradictions: string[] = [];

  let score = 0;
  const isPermanentlyClosed = input.businessStatus === 'CLOSED_PERMANENTLY';
  const isTemporarilyClosed = input.businessStatus === 'CLOSED_TEMPORARILY';
  const isOperational = !isPermanentlyClosed && !isTemporarilyClosed;

  if (input.businessStatus === 'OPERATIONAL') {
    score += 25;
    breakdown.push({
      label: 'Establecimiento en estado OPERATIONAL',
      points: 25,
      provenance: 'google_reference',
    });
    reasons.push('Estado operativo activo reportado.');
  } else if (isTemporarilyClosed) {
    score -= 20;
    contradictions.push('Establecimiento figura como CERRADO TEMPORALMENTE.');
    breakdown.push({
      label: 'Advertencia: cierre temporal reportado',
      points: -20,
      provenance: 'google_reference',
    });
    reasons.push('Figura cerrado temporalmente; verificar reapertura antes de gestionar.');
  } else if (isPermanentlyClosed) {
    score -= 50;
    contradictions.push('Establecimiento figura como CERRADO PERMANENTEMENTE.');
    breakdown.push({
      label: 'Cierre permanente reportado',
      points: -50,
      provenance: 'google_reference',
    });
    reasons.push('Figura cerrado permanentemente; no elegible.');
  } else {
    score += 5;
    reasons.push('Estado operativo no confirmado.');
  }

  const completeness = evaluateFollowupCompleteness({
    independentBusinessName: input.independentBusinessName || '',
    independentPhone: input.independentPhone || '',
    independentAddress: input.independentAddress || '',
    district: input.district || '',
    independentWebsite: input.independentWebsite || '',
    confirmedNoWebsite: Boolean(input.confirmedNoWebsite),
    independentEmail: '',
    independentCategory: input.independentCategory || '',
  });

  if (completeness.status === 'complete') {
    score += 35;
    breakdown.push({
      label: 'Identidad comercial independiente completa (4/4 campos clave)',
      points: 35,
      provenance: 'independent_verified',
    });
    reasons.push('Ficha comercial completa con datos persistentes verificados.');
  } else if (completeness.status === 'partial') {
    score += 15;
    breakdown.push({
      label: 'Identidad comercial parcial (faltan campos independientes)',
      points: 15,
      provenance: 'independent_verified',
    });
    reasons.push(`FICHA INCOMPLETA: faltan ${completeness.missingFields.join(', ')}.`);
  } else {
    breakdown.push({
      label: 'Sin campos comerciales independientes corroborados aún',
      points: 0,
      provenance: 'google_reference',
    });
    reasons.push('FICHA INCOMPLETA: solo identificador o referencia de sesión.');
  }

  // Corroboración cruzada entre fuentes
  const sourcesCount = input.verificationSourcesCount || 0;
  if (sourcesCount >= 3) {
    score += 15;
    breakdown.push({
      label: `Concordancia respaldada por ${sourcesCount} registros de procedencia`,
      points: 15,
      provenance: 'independent_verified',
    });
  } else if (sourcesCount >= 1) {
    score += 8;
    breakdown.push({
      label: `Procedencia parcial registrada (${sourcesCount} fuente(s))`,
      points: 8,
      provenance: 'independent_verified',
    });
  }

  // Estado técnico web verificable (no inconcluso)
  if (
    input.websiteProbe.provenance === 'independent_http' ||
    input.confirmedNoWebsite ||
    input.websiteProbe.status === 'confirmed_none'
  ) {
    if (input.websiteProbe.status === 'unverified_inconclusive') {
      score += 0;
      reasons.push('Verificación HTTP inconclusa reduce confianza técnica.');
    } else {
      score += 15;
      breakdown.push({
        label: 'Señal web corroborada (sonda HTTP o confirmación manual)',
        points: 15,
        provenance: 'independent_verified',
      });
    }
  }

  // Frescura de verificación (<= 30 días)
  if (input.lastVerifiedAt && !Number.isNaN(Date.parse(input.lastVerifiedAt))) {
    const ageDays = (Date.now() - Date.parse(input.lastVerifiedAt)) / (1000 * 60 * 60 * 24);
    if (ageDays <= 30) {
      score += 10;
      breakdown.push({
        label: 'Verificación reciente (<= 30 días)',
        points: 10,
        provenance: 'independent_verified',
      });
    }
  }

  // Detección explícita de contradicciones
  if (input.confirmedNoWebsite && (input.independentWebsite || '').trim().length > 0) {
    score -= 30;
    contradictions.push(
      'Contradicción: marcado como confirmado sin web pero registra URL web independiente.'
    );
  }
  if (
    input.websiteProbe.status === 'active_https' &&
    Boolean(input.confirmedNoWebsite)
  ) {
    score -= 30;
    contradictions.push(
      'Contradicción: existe sitio HTTPS activo pero figura marcado como sin web.'
    );
  }
  if (
    input.commercialOutcome === 'datos_incorrectos' ||
    input.commercialOutcome === 'numero_inexistente' ||
    input.commercialOutcome === 'no_corresponde'
  ) {
    score -= 35;
    contradictions.push(
      `Resultado real reportado: "${input.commercialOutcome}" invalida la confiabilidad actual.`
    );
  }

  const finalScore = Math.max(0, Math.min(100, score));
  const label =
    contradictions.length > 0
      ? 'Confianza con Alertas / Contradicciones'
      : finalScore >= 75
      ? 'Confianza Alta'
      : finalScore >= 45
      ? 'Confianza Media (Revisar)'
      : 'Confianza Baja / Incompleta';

  return {
    score: finalScore,
    label,
    isOperational,
    hasContradictions: contradictions.length > 0,
    contradictions,
    missingCoreFields: completeness.missingFields,
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
      evaluateFollowupCompleteness(f).status === 'complete' ||
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
    (f) => AUTHORIZED_OUTREACH_STAGES.has(f.stage) && (f.legalBasis || '').trim().length >= 8
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

/**
 * Calcula estadísticas de conversión real y calibración determinística protegiendo contra sobreajuste en muestras pequeñas.
 */
export function computeOutcomeCalibrationStats(
  followups: FollowupLeadRecord[]
): OutcomeCalibrationStats {
  const minimumSampleThreshold = 10;
  const reviewedCount = followups.length;

  const corroboratedCount = followups.filter(
    (f) => evaluateFollowupCompleteness(f).status === 'complete'
  ).length;

  const legallyAuthorizedCount = followups.filter(
    (f) => AUTHORIZED_OUTREACH_STAGES.has(f.stage) && (f.legalBasis || '').trim().length >= 8
  ).length;

  const reachedCount = followups.filter(
    (f) =>
      f.stage === 'CONTACTADO' ||
      f.stage === 'RESPONDIÓ' ||
      f.stage === 'INTERESADO' ||
      f.stage === 'COTIZACIÓN' ||
      f.stage === 'CLIENTE' ||
      (f.commercialOutcome &&
        f.commercialOutcome !== 'none' &&
        f.commercialOutcome !== 'datos_incorrectos')
  ).length;

  const effectiveResponsesCount = followups.filter(
    (f) =>
      f.stage === 'RESPONDIÓ' ||
      f.stage === 'INTERESADO' ||
      f.stage === 'COTIZACIÓN' ||
      f.stage === 'CLIENTE' ||
      f.commercialOutcome === 'respondio' ||
      f.commercialOutcome === 'interesado' ||
      f.commercialOutcome === 'cotizacion_enviada' ||
      f.commercialOutcome === 'venta_confirmada'
  ).length;

  const interestedCount = followups.filter(
    (f) =>
      f.stage === 'INTERESADO' ||
      f.stage === 'COTIZACIÓN' ||
      f.stage === 'CLIENTE' ||
      f.commercialOutcome === 'interesado' ||
      f.commercialOutcome === 'cotizacion_enviada' ||
      f.commercialOutcome === 'venta_confirmada'
  ).length;

  const quotationsCount = followups.filter(
    (f) =>
      f.stage === 'COTIZACIÓN' ||
      f.stage === 'CLIENTE' ||
      f.commercialOutcome === 'cotizacion_enviada' ||
      f.commercialOutcome === 'venta_confirmada'
  ).length;

  const confirmedSalesCount = followups.filter(
    (f) => f.stage === 'CLIENTE' || f.commercialOutcome === 'venta_confirmada'
  ).length;

  const negativeOutcomesCount = followups.filter(
    (f) =>
      f.commercialOutcome === 'datos_incorrectos' ||
      f.commercialOutcome === 'numero_inexistente' ||
      f.commercialOutcome === 'no_corresponde' ||
      f.commercialOutcome === 'no_volver_a_contactar'
  ).length;

  const sampleSizeSufficient = reachedCount >= minimumSampleThreshold;
  const insights: string[] = [];

  if (!sampleSizeSufficient) {
    insights.push(
      `Muestra pequeña (${reachedCount}/${minimumSampleThreshold} contactos alcanzados): se bloquea el ajuste automático de criterios para evitar sobreajuste estadístico.`
    );
  } else {
    const badDataPct = Math.round((negativeOutcomesCount / reachedCount) * 100);
    const responsePct = Math.round((effectiveResponsesCount / reachedCount) * 100);
    insights.push(
      `Tasa real de respuesta efectiva sobre contactos alcanzados: ${responsePct}% (${effectiveResponsesCount}/${reachedCount}).`
    );
    if (badDataPct >= 25) {
      insights.push(
        `Alerta de calibración: ${badDataPct}% de contactos alcanzados reportaron datos incorrectos o no correspondientes; exigir corroboración en web oficial antes de autorizar.`
      );
    } else {
      insights.push(
        `Calidad de datos aceptable (${badDataPct}% incidencias negativas sobre ${reachedCount} alcanzados).`
      );
    }
  }

  return {
    reviewedCount,
    corroboratedCount,
    legallyAuthorizedCount,
    reachedCount,
    effectiveResponsesCount,
    interestedCount,
    quotationsCount,
    confirmedSalesCount,
    negativeOutcomesCount,
    sampleSizeSufficient,
    minimumSampleThreshold,
    insights,
  };
}
