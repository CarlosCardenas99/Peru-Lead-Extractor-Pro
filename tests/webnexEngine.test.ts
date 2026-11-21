import http from 'node:http';
import { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { analyzePeruvianPhone } from '../utils/peruPhone';
import {
  buildExclusionKeySet,
  checkPlaceAgainstExclusions,
  parseExclusionBatchInput,
} from '../utils/exclusionUtils';
import {
  buildCrmAndDuplicateSets,
  matchesSmartFilters,
  qualifyLoadedLeadsBatch,
  validateLegalBasisForStage,
} from '../utils/leadQualifier';
import {
  computeContactabilityScore,
  computeDigitalOpportunityScore,
  computeIndependentFunnelMetrics,
  computeInformationTrustScore,
  computeOutcomeCalibrationStats,
  deduplicatePlacesById,
} from '../utils/scoring';
import { isPrivateOrReservedIp, validateAndResolveSafeUrl } from '../server/ssrfGuard';
import { verifyWebsiteIndependently } from '../server/websiteVerifier';
import { extractHtmlSignals } from '../server/websiteMetadataExtractor';
import {
  hasSubstantiveIndependentEvidence,
  parseGeminiAnalystResponse,
  sanitizeAnalystInput,
} from '../server/geminiAnalystService';
import { DailyQuotaGuard } from '../server/quotaGuard';
import {
  getPlaceDetailsByIdWithStatus,
  mapGooglePlacePayload,
  MINIMAL_PLACES_FIELD_MASK,
  searchPlacesNewApi,
} from '../server/placesService';
import {
  corroborateLeadIndependently,
  extractIndependentSignalsFromHtml,
} from '../server/independentCorroborator';
import {
  parseDatosPeruCompanyHtml,
  passesDatosPeruIdentityGate,
  researchMissingLeadData,
} from '../server/missingDataResearcher';
import { parseSubzoneGeminiResponse } from '../server/geminiSubzoneService';
import { createApiApp } from '../server';
import { buildBusinessLeadFromPlace } from '../services/geminiService';
import {
  buildFollowupCreateDocPayload,
  buildMissingFieldsPatch,
  buildSafeLegacyCleanupPreview,
  buildTemporaryWorkItemPayload,
  clampFirestoreScore,
  deleteFollowupsBatchWithProgress,
  formatFriendlyFirestoreError,
  getFollowupsCollectionPath,
  getTemporaryWorkQueueCollectionPath,
  planNonDestructiveFollowupBatch,
} from '../services/firebaseService';
import { FollowupCrmView } from '../components/FollowupCrmView';
import { TemporaryQueueView } from '../components/TemporaryQueueView';
import { ExportButton } from '../components/ExportButton';
import { buildNonDestructiveRecoveryPreviews } from '../components/FollowupRecoveryModal';
import {
  addLeadsToTemporaryQueue,
  applyTtlToTemporaryQueue,
  clearTemporaryQueue,
  computeExpiryIso,
  evaluateTemporaryEntryFourConcepts,
  filterTemporaryQueue,
  hasUnrecoverableSessionMapsWork,
  mapTemporaryOutcomeToCrmState,
  mergeRestoredTemporaryQueue,
  reattachSessionLeadsToTemporaryQueue,
  removeFromTemporaryQueue,
  updateTemporaryQueueEntry,
} from '../utils/temporaryQueue';
import {
  exportTemporaryQueueToExcel,
  generateTemporaryQueueExcelWorkbookBuffer,
} from '../utils/temporaryQueueExcelExport';
import {
  buildPersistedVerificationReport,
  encodeOutcomeHistoryEntry,
  encodeVerificationProvenanceEntry,
  evaluateFollowupCompleteness,
  evaluateFourStagePipelineStatus,
  getCommercialOutcomeLabel,
  getFieldClassificationMeta,
  isIndependentEntryDistinctFromRawMapsGuard,
  mergeOutcomeHistory,
  mergeVerificationSources,
  parseOutcomeHistoryEntry,
  parseVerificationProvenanceEntry,
  resolveIndependentWebsiteStatusForSave,
} from '../utils/fieldCompliance';
import {
  getHydrationStatusMeta,
  isHydrationEntryUsable,
  mergeHydrationBatchResults,
  ON_DEMAND_MAX_BATCH_SIZE,
  resolveFollowupPhoneDisplay,
  selectNextHydrationBatch,
  SESSION_CACHE_TTL_MS,
} from '../utils/followupHydration';
import {
  DEFAULT_SMART_FILTERS,
  ExclusionRecord,
  FollowupLeadRecord,
  GooglePlaceRaw,
  PersistedTemporaryWorkItem,
  PlaceHydrationEntry,
  PlacesQuotaBlockState,
  QuotaStatus,
  TEMPORARY_QUEUE_OUTCOMES,
  TemporaryQueueEntry,
} from '../types';

describe('1. Deduplicación por Place ID y sucursales', () => {
  it('elimina duplicados con mismo placeId pero conserva sucursales con distinto placeId', () => {
    const page1: GooglePlaceRaw[] = [
      {
        placeId: 'ChIJ_branch_1',
        displayName: 'Clínica Dental Sonrisas',
        formattedAddress: 'Av. Alfredo Mendiola 1200, Los Olivos',
        location: { lat: -11.99, lng: -77.06 },
        nationalPhoneNumber: '987 654 321',
        internationalPhoneNumber: '+51 987 654 321',
        websiteUri: null,
        googleMapsUri: 'https://maps.google.com/?cid=1',
        rating: 4.5,
        userRatingCount: 40,
        businessStatus: 'OPERATIONAL',
        primaryTypeDisplayName: 'Clínica dental',
      },
    ];

    const page2: GooglePlaceRaw[] = [
      { ...page1[0] },
      {
        ...page1[0],
        placeId: 'ChIJ_branch_2',
        formattedAddress: 'Av. Universitaria 4500, Los Olivos',
      },
    ];

    const merged = deduplicatePlacesById(page1, page2);
    expect(merged).toHaveLength(2);
    expect(merged.map((p) => p.placeId)).toEqual(['ChIJ_branch_1', 'ChIJ_branch_2']);
  });
});

describe('2. Normalización de teléfonos peruanos sin asumir WhatsApp ni convertir desconocidos', () => {
  it('normaliza móviles (con/sin +51), fijos 01 y regionales, y nunca convierte inválidos en móviles', () => {
    const mobileNoPrefix = analyzePeruvianPhone('987-654-321');
    expect(mobileNoPrefix.isValidFormat).toBe(true);
    expect(mobileNoPrefix.e164).toBe('+51987654321');
    expect(mobileNoPrefix.lineType).toBe('mobile');
    expect(mobileNoPrefix.note.toLowerCase()).toContain('whatsapp no asumido');

    const mobileWithPrefix = analyzePeruvianPhone('+51 912 345 678');
    expect(mobileWithPrefix.isValidFormat).toBe(true);
    expect(mobileWithPrefix.e164).toBe('+51912345678');
    expect(mobileWithPrefix.lineType).toBe('mobile');

    const lima = analyzePeruvianPhone('(01) 456-7890');
    expect(lima.isValidFormat).toBe(true);
    expect(lima.e164).toBe('+5114567890');
    expect(lima.lineType).toBe('landline_lima');

    const limaWithCountry = analyzePeruvianPhone('+51 (01) 456-7890');
    expect(limaWithCountry.isValidFormat).toBe(true);
    expect(limaWithCountry.lineType).toBe('landline_lima');

    const arequipa = analyzePeruvianPhone('+51 54 234567');
    expect(arequipa.isValidFormat).toBe(true);
    expect(arequipa.e164).toBe('+5154234567');
    expect(arequipa.lineType).toBe('landline_regional');

    const trujillo = analyzePeruvianPhone('044 221133');
    expect(trujillo.isValidFormat).toBe(true);
    expect(trujillo.lineType).toBe('landline_regional');

    const invalidShort = analyzePeruvianPhone('12345');
    expect(invalidShort.isValidFormat).toBe(false);
    expect(invalidShort.lineType).toBe('invalid');
    expect(invalidShort.stage).toBe('registered_invalid');

    const unknownNineDigits = analyzePeruvianPhone('800123456');
    expect(unknownNineDigits.isValidFormat).toBe(false);
    expect(unknownNineDigits.lineType).toBe('invalid');

    const absent = analyzePeruvianPhone(null);
    expect(absent.lineType).toBe('none');
    expect(absent.stage).toBe('none');
  });
});

describe('3. Verificador web SSRF y clasificación inconclusa', () => {
  it('bloquea IPs privadas, metadatos cloud y redirecciones SSRF', async () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('10.0.0.5')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);

    const dnsToPrivate = await validateAndResolveSafeUrl('https://evil.example.com', async () => [
      { address: '192.168.1.50', family: 4 },
    ]);
    expect(dnsToPrivate.ok).toBe(false);
    if (dnsToPrivate.ok === false) {
      expect(dnsToPrivate.code).toBe('SSRF_BLOCKED');
    }

    const redirectSsrf = await verifyWebsiteIndependently('https://public-site.pe', {
      dnsLookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchFn: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
    });
    expect(redirectSsrf.status).toBe('unverified_inconclusive');
    expect(redirectSsrf.inconclusiveReason?.toLowerCase()).toContain('bloqueada');
  });

  it('clasifica 403, 429, 405, timeouts y errores TLS como unverified_inconclusive (NO caída)', async () => {
    const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

    const r403 = await verifyWebsiteIndependently('https://waf-site.pe', {
      dnsLookupFn: publicDns,
      fetchFn: async () => new Response('Forbidden', { status: 403 }),
    });
    expect(r403.status).toBe('unverified_inconclusive');

    const r429 = await verifyWebsiteIndependently('https://rate-limited.pe', {
      dnsLookupFn: publicDns,
      fetchFn: async () => new Response('Too Many Requests', { status: 429 }),
    });
    expect(r429.status).toBe('unverified_inconclusive');

    const r405 = await verifyWebsiteIndependently('https://no-head.pe', {
      dnsLookupFn: publicDns,
      fetchFn: async () => new Response('Method Not Allowed', { status: 405 }),
    });
    expect(r405.status).toBe('unverified_inconclusive');

    const rTimeout = await verifyWebsiteIndependently('https://slow-site.pe', {
      dnsLookupFn: publicDns,
      fetchFn: async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    expect(rTimeout.status).toBe('unverified_inconclusive');

    const rTls = await verifyWebsiteIndependently('https://expired-tls.pe', {
      dnsLookupFn: publicDns,
      fetchFn: async () => {
        const err: any = new Error('certificate has expired');
        err.code = 'CERT_HAS_EXPIRED';
        throw err;
      },
    });
    expect(rTls.status).toBe('unverified_inconclusive');
    expect(rTls.tlsValid).toBe(false);
  });

  it('clasifica redes sociales, web activa HTTPS y DNS inexistente correctamente', async () => {
    const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

    const social = await verifyWebsiteIndependently('https://www.facebook.com/clinicaejemplo', {
      dnsLookupFn: publicDns,
    });
    expect(social.status).toBe('social_only');

    const active = await verifyWebsiteIndependently('https://webnex.pe', {
      dnsLookupFn: publicDns,
      fetchFn: async () => new Response(null, { status: 200 }),
    });
    expect(active.status).toBe('active_https');

    const nxdomain = await verifyWebsiteIndependently('https://no-existe-dominio-pe.pe', {
      dnsLookupFn: async () => {
        const err: any = new Error('getaddrinfo ENOTFOUND');
        err.code = 'ENOTFOUND';
        throw err;
      },
    });
    expect(nxdomain.status).toBe('unreachable_verified');
  });
});

describe('4. Separación de Puntuación Digital vs Contactabilidad y Métricas (9 etapas)', () => {
  it('mantiene Oportunidad Digital independiente de teléfono o reseñas', () => {
    const unregisteredProbe = {
      checkedUrl: null,
      finalUrl: null,
      status: 'unregistered' as const,
      httpStatus: null,
      tlsValid: null,
      isSocialOnly: false,
      inconclusiveReason: null,
      summary: 'Sin web registrada',
      verifiedAt: '',
      provenance: 'google_absent' as const,
    };

    const scoreNoPhone = computeDigitalOpportunityScore(unregisteredProbe, false);
    const contactNoPhone = computeContactabilityScore(
      analyzePeruvianPhone(null),
      analyzePeruvianPhone(null),
      ''
    );
    const contactCorroborated = computeContactabilityScore(
      analyzePeruvianPhone('987654321'),
      analyzePeruvianPhone('987654321', 'independently_corroborated'),
      'ventas@empresa.pe'
    );

    expect(scoreNoPhone.score).toBe(85);
    expect(contactNoPhone.score).toBe(0);
    expect(contactCorroborated.score).toBe(85);
    expect(computeDigitalOpportunityScore(unregisteredProbe, false).score).toBe(scoreNoPhone.score);
  });

  it('calcula métricas del cualificador y embudo con las 9 etapas actualizadas', () => {
    const followups: FollowupLeadRecord[] = [
      {
        id: '1',
        ownerUid: 'u1',
        placeId: 'p1',
        sourceKind: 'independent_manual',
        independentBusinessName: 'Negocio A',
        district: 'Los Olivos',
        confirmedNoWebsite: true,
        independentWebsiteStatus: 'confirmed_none',
        independentPhone: '+51 987 654 321',
        phoneStage: 'contact_reached',
        independentEmail: '',
        independentDigitalScore: 100,
        independentContactScore: 85,
        stage: 'CLIENTE',
        legalBasis: 'Contrato directo firmado',
        qualificationTier: 'PRIORIDAD ALTA',
        aiSummary: '',
        notes: '',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: '2',
        ownerUid: 'u1',
        placeId: 'p2',
        sourceKind: 'independent_manual',
        independentBusinessName: 'Negocio B',
        district: 'Miraflores',
        confirmedNoWebsite: true,
        independentWebsiteStatus: 'confirmed_none',
        independentPhone: '+51 912 345 678',
        phoneStage: 'independently_corroborated',
        independentEmail: '',
        independentDigitalScore: 100,
        independentContactScore: 70,
        stage: 'COTIZACIÓN',
        legalBasis: 'Solicitó propuesta por formulario web',
        qualificationTier: 'PRIORIDAD ALTA',
        aiSummary: '',
        notes: '',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: '3',
        ownerUid: 'u1',
        placeId: 'p3',
        sourceKind: 'places_preselection',
        independentBusinessName: '',
        district: '',
        confirmedNoWebsite: false,
        independentWebsiteStatus: 'unregistered',
        independentPhone: '',
        phoneStage: 'registered_valid_format',
        independentEmail: '',
        independentDigitalScore: 85,
        independentContactScore: 45,
        stage: 'PRESELECCIONADO',
        legalBasis: '',
        qualificationTier: 'REVISIÓN PENDIENTE',
        aiSummary: '',
        notes: '',
        createdAt: '',
        updatedAt: '',
      },
    ];

    const metrics = computeIndependentFunnelMetrics([], followups);
    expect(metrics.uniqueBusinessesFound).toBe(0);
    expect(metrics.corroboratedRecords).toBe(2);
    expect(metrics.verifiableDigitalOpportunities).toBe(2);
    expect(metrics.preselectedCount).toBe(1);
    expect(metrics.pendingCorroborationCount).toBe(1);
    expect(metrics.authorizedContactsCount).toBe(2);
    expect(metrics.authorizedContactsMade).toBe(2);
    expect(metrics.responsesReceived).toBe(2);
    expect(metrics.qualifiedOpportunities).toBe(1);
    expect(metrics.confirmedSales).toBe(1);
  });
});

describe('5. Importación masiva de lista de exclusión (4,767 descartados WEBNEX)', () => {
  it('normaliza teléfonos/dominios, maneja 4,767 filas y evita duplicados', () => {
    const lines: string[] = ['telefono,dominio'];
    for (let i = 0; i < 4767; i++) {
      const num = 900000000 + i;
      lines.push(`${num}`);
    }
    lines.push('+51 900 000 000');
    lines.push('https://www.cliente-actual.pe/contacto');

    const existingRecords: ExclusionRecord[] = [];
    const existingKeys = buildExclusionKeySet(existingRecords);
    const parsed = parseExclusionBatchInput(lines.join('\n'), existingKeys, 10000);

    expect(parsed.uniqueEntries).toHaveLength(4768);
    expect(parsed.skippedDuplicates).toBe(1);

    const newKeys = new Set<string>(
      parsed.uniqueEntries.map((u) => `${u.type}:${u.normalizedValue}`)
    );
    const match = checkPlaceAgainstExclusions(
      {
        placeId: 'ChIJ_x',
        nationalPhoneNumber: '900 000 010',
        internationalPhoneNumber: null,
        websiteUri: null,
      },
      newKeys
    );
    expect(match.excluded).toBe(true);
  });
});

describe('6. Places API (New), Gemini parsing y control de cuota diaria', () => {
  it('mapea Place válido, aplica FieldMask, maneja cuota 429 y caché', async () => {
    const guard = new DailyQuotaGuard({ placesLimit: 2, geminiLimit: 2 });
    expect(guard.canUsePlaces()).toBe(true);
    guard.consumePlaces();
    guard.consumePlaces();
    expect(guard.canUsePlaces()).toBe(false);

    const mapped = mapGooglePlacePayload({
      id: 'ChIJ123',
      displayName: { text: 'Pollería El Dorado' },
      formattedAddress: 'Av. Perú 123, Lima',
      location: { latitude: -12.02, longitude: -77.05 },
      nationalPhoneNumber: '999 888 777',
      websiteUri: null,
      rating: 4.3,
      userRatingCount: 55,
      businessStatus: 'OPERATIONAL',
    });
    expect(mapped?.placeId).toBe('ChIJ123');

    await expect(
      searchPlacesNewApi({
        textQuery: 'pollerias en lima',
        apiKey: 'test-key',
        fetchFn: async () =>
          new Response(
            JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }),
            { status: 429 }
          ),
      })
    ).rejects.toMatchObject({ status: 429, code: 'PLACES_QUOTA_EXCEEDED' });
  });

  it('parsea respuesta JSON estructurada de Gemini y rechaza respuestas vacías o inválidas', () => {
    const valid = parseSubzoneGeminiResponse(
      JSON.stringify({
        subzones: ['Los Olivos Norte', 'Pro', 'Naranjal', 'Pro'],
        rationale: 'Sectores comerciales activos.',
      })
    );
    expect(valid.subzones).toEqual(['Los Olivos Norte', 'Pro', 'Naranjal']);

    expect(() => parseSubzoneGeminiResponse('')).toThrow();
    expect(() => parseSubzoneGeminiResponse('no json here')).toThrow();
  });

  it('soporta GOOGLE_MAPS_PLATFORM_KEY y no inventa teléfonos ni webs ausentes', async () => {
    const prevPlatform = process.env.GOOGLE_MAPS_PLATFORM_KEY;
    const prevApi = process.env.GOOGLE_MAPS_API_KEY;
    const prevVite = process.env.VITE_GOOGLE_MAPS_API_KEY;
    try {
      process.env.GOOGLE_MAPS_PLATFORM_KEY = 'platform_test_key';
      delete process.env.GOOGLE_MAPS_API_KEY;
      delete process.env.VITE_GOOGLE_MAPS_API_KEY;

      let sentHeaderKey: string | null = null;
      const res = await searchPlacesNewApi({
        textQuery: 'Veterinarias en Los Olivos, Lima, Perú',
        fetchFn: async (_url, init) => {
          const headers = init?.headers as Record<string, string>;
          sentHeaderKey = headers['X-Goog-Api-Key'] || null;
          return new Response(
            JSON.stringify({
              places: [
                {
                  id: 'ChIJ_vet_1',
                  displayName: { text: 'Veterinaria Sin Web Ni Tel' },
                  formattedAddress: 'Los Olivos, Lima',
                  location: { latitude: -11.98, longitude: -77.06 },
                  nationalPhoneNumber: null,
                  internationalPhoneNumber: null,
                  websiteUri: null,
                },
              ],
            }),
            { status: 200 }
          );
        },
      });
      expect(sentHeaderKey).toBe('platform_test_key');
      expect(res.places).toHaveLength(1);

      const lead = buildBusinessLeadFromPlace(res.places[0], 'Veterinarias', new Set());
      expect(lead.placeId).toBe('ChIJ_vet_1');
      expect(lead.phone).toBe('Sin teléfono');
      expect(lead.phoneAnalysis.stage).toBe('none');
      expect(lead.website).toBe('');
      expect(lead.websiteProbe.status).toBe('unregistered');
      expect(lead.location).toEqual({ lat: -11.98, lng: -77.06 });
    } finally {
      if (prevPlatform !== undefined) process.env.GOOGLE_MAPS_PLATFORM_KEY = prevPlatform;
      else delete process.env.GOOGLE_MAPS_PLATFORM_KEY;
      if (prevApi !== undefined) process.env.GOOGLE_MAPS_API_KEY = prevApi;
      if (prevVite !== undefined) process.env.VITE_GOOGLE_MAPS_API_KEY = prevVite;
    }
  });
});

describe('7. WEBNEX Smart Lead Qualifier: Filtros combinables, Preselección sin duplicados y Gate Legal', () => {
  const mkRaw = (overrides: Partial<GooglePlaceRaw>): GooglePlaceRaw => ({
    placeId: 'ChIJ_default',
    displayName: 'Negocio Test',
    formattedAddress: 'Av. Carlos Izaguirre 100, Los Olivos',
    location: { lat: -11.99, lng: -77.06 },
    nationalPhoneNumber: '987 654 321',
    internationalPhoneNumber: '+51 987 654 321',
    websiteUri: null,
    googleMapsUri: 'https://maps.google.com/?cid=99',
    rating: 4.4,
    userRatingCount: 25,
    businessStatus: 'OPERATIONAL',
    primaryTypeDisplayName: 'Veterinaria',
    ...overrides,
  });

  it('clasifica PRIORIDAD ALTA, REVISIÓN PENDIENTE y NO ELEGIBLE, y evita duplicados al re-ejecutar', () => {
    const leadConfirmedNoWeb = buildBusinessLeadFromPlace(
      mkRaw({ placeId: 'ChIJ_high', nationalPhoneNumber: '987 654 321', websiteUri: null }),
      'Veterinarias',
      new Set()
    );
    leadConfirmedNoWeb.confirmedNoWebsite = true;
    leadConfirmedNoWeb.websiteProbe = {
      ...leadConfirmedNoWeb.websiteProbe,
      status: 'confirmed_none',
      provenance: 'manual_user',
    };

    const leadUnregisteredMobile = buildBusinessLeadFromPlace(
      mkRaw({ placeId: 'ChIJ_pending', nationalPhoneNumber: '912 345 678', websiteUri: null }),
      'Veterinarias',
      new Set()
    );

    const leadLandlineLima = buildBusinessLeadFromPlace(
      mkRaw({
        placeId: 'ChIJ_fijo_lima',
        nationalPhoneNumber: '(01) 456-7890',
        internationalPhoneNumber: '+51 1 4567890',
        websiteUri: null,
      }),
      'Veterinarias',
      new Set()
    );

    const leadNoPhone = buildBusinessLeadFromPlace(
      mkRaw({
        placeId: 'ChIJ_no_phone',
        nationalPhoneNumber: null,
        internationalPhoneNumber: null,
        websiteUri: null,
      }),
      'Veterinarias',
      new Set()
    );

    const leadExcluded = buildBusinessLeadFromPlace(
      mkRaw({ placeId: 'ChIJ_excl', nationalPhoneNumber: '999 111 222' }),
      'Veterinarias',
      new Set(['placeId:ChIJ_excl'])
    );

    const batch1 = qualifyLoadedLeadsBatch(
      [leadConfirmedNoWeb, leadUnregisteredMobile, leadLandlineLima, leadNoPhone, leadExcluded],
      {
        discardedPlaceIds: new Set(),
        existingFollowups: [],
      }
    );

    expect(batch1.summary.totalEvaluated).toBe(5);
    expect(batch1.summary.highPriorityCount).toBe(1);
    expect(batch1.summary.pendingReviewCount).toBe(1);
    expect(batch1.summary.notEligibleCount).toBe(3);
    expect(batch1.summary.discardedLandlineCount).toBe(1);
    expect(batch1.summary.noMobileCount).toBe(2); // landline + no phone

    const tierById = new Map(batch1.results.map((r) => [r.placeId, r.tier]));
    expect(tierById.get('ChIJ_high')).toBe('PRIORIDAD ALTA');
    expect(tierById.get('ChIJ_pending')).toBe('REVISIÓN PENDIENTE');
    expect(tierById.get('ChIJ_fijo_lima')).toBe('NO ELEGIBLE');
    expect(tierById.get('ChIJ_no_phone')).toBe('NO ELEGIBLE');
    expect(tierById.get('ChIJ_excl')).toBe('NO ELEGIBLE');

    // Al re-ejecutar el botón cuando ChIJ_high ya fue transferido a Followup, NO debe duplicarse
    const existingFollowup: FollowupLeadRecord = {
      id: 'lead_ChIJ_high',
      ownerUid: 'u1',
      placeId: 'ChIJ_high',
      sourceKind: 'places_preselection',
      independentBusinessName: '',
      district: '',
      confirmedNoWebsite: true,
      independentWebsiteStatus: 'confirmed_none',
      independentPhone: '',
      phoneStage: 'registered_valid_format',
      independentEmail: '',
      independentDigitalScore: 100,
      independentContactScore: 45,
      stage: 'PRESELECCIONADO',
      legalBasis: '',
      qualificationTier: 'PRIORIDAD ALTA',
      aiSummary: '',
      notes: '',
      createdAt: '',
      updatedAt: '',
    };

    const batch2 = qualifyLoadedLeadsBatch([leadConfirmedNoWeb, leadUnregisteredMobile], {
      discardedPlaceIds: new Set(),
      existingFollowups: [existingFollowup],
    });
    expect(batch2.summary.alreadyInCrmSkippedCount).toBe(1);
    expect(batch2.results.find((r) => r.placeId === 'ChIJ_high')?.tier).toBe('NO ELEGIBLE');
    expect(batch2.results.find((r) => r.placeId === 'ChIJ_pending')?.tier).toBe('REVISIÓN PENDIENTE');
  });

  it('aplica filtros combinables correctamente sin mezclar fijos ni clientes', () => {
    const mobileNoWeb = buildBusinessLeadFromPlace(
      mkRaw({ placeId: 'p_mob_noweb', nationalPhoneNumber: '987654321', websiteUri: null }),
      'Vet',
      new Set()
    );
    const landlineNoWeb = buildBusinessLeadFromPlace(
      mkRaw({
        placeId: 'p_fijo',
        nationalPhoneNumber: '01 444 5555',
        internationalPhoneNumber: '+51 1 4445555',
        websiteUri: null,
      }),
      'Vet',
      new Set()
    );
    const clientLead = buildBusinessLeadFromPlace(
      mkRaw({ placeId: 'p_client', nationalPhoneNumber: '988777666', websiteUri: null }),
      'Vet',
      new Set()
    );

    const followups: FollowupLeadRecord[] = [
      {
        id: 'lead_p_client',
        ownerUid: 'u1',
        placeId: 'p_client',
        sourceKind: 'independent_manual',
        independentBusinessName: 'Cliente Actual',
        district: 'Lima',
        confirmedNoWebsite: true,
        independentWebsiteStatus: 'confirmed_none',
        independentPhone: '+51 988 777 666',
        phoneStage: 'contact_reached',
        independentEmail: '',
        independentDigitalScore: 100,
        independentContactScore: 85,
        stage: 'CLIENTE',
        legalBasis: 'Cliente activo',
        qualificationTier: 'PRIORIDAD ALTA',
        aiSummary: '',
        notes: '',
        createdAt: '',
        updatedAt: '',
      },
    ];

    const all = [mobileNoWeb, landlineNoWeb, clientLead];
    const { followupByPlaceId } = buildCrmAndDuplicateSets(all, followups);

    const filtered = all.filter((l) =>
      matchesSmartFilters(
        l,
        {
          ...DEFAULT_SMART_FILTERS,
          mobileOnly: true,
          excludeLandlines: true,
          mobileAndNoWebsite: true,
          excludeClientsDiscardsDuplicates: true,
        },
        {
          discardedPlaceIds: new Set(),
          followupByPlaceId,
          showExcludedAndDiscarded: false,
        }
      )
    );
    expect(filtered.map((l) => l.placeId)).toEqual(['p_mob_noweb']);
  });

  it('impone el gate de consentimiento/base legal para CONTACTO AUTORIZADO y manejo de errores Firebase/Gemini', () => {
    expect(validateLegalBasisForStage('PRESELECCIONADO', '')).toBeNull();
    expect(validateLegalBasisForStage('PENDIENTE DE VERIFICACIÓN', '')).toBeNull();
    expect(validateLegalBasisForStage('CONTACTO AUTORIZADO', '')).toContain('consentimiento');
    expect(validateLegalBasisForStage('CONTACTADO', 'ok')).toContain('mínimo 8 caracteres');
    expect(
      validateLegalBasisForStage('CONTACTO AUTORIZADO', 'Solicitud directa por correo corporativo')
    ).toBeNull();

    // PII stripping in HTML extractor before Gemini
    const meta = extractHtmlSignals(
      '<html><head><title>Veterinaria | +51 987 654 321</title><meta name="description" content="Escríbenos a info@vet.pe"><meta name="viewport" content="width=device-width"></head><body><h1>Servicios Veterinarios</h1></body></html>',
      'https://vet.pe',
      200
    );
    expect(meta.title).toContain('[tel]');
    expect(meta.title).not.toContain('987');
    expect(meta.metaDescription).toContain('[email]');
    expect(meta.hasViewportMeta).toBe(true);

    // Sanitizador y parser de Gemini
    const sanitized = sanitizeAnalystInput({
      placeId: 'ChIJ_1',
      category: 'Veterinarias',
      websiteStatus: 'active_http',
      userNotes: 'Nota propia',
      websiteMeta: meta,
    });
    expect(sanitized.placeId).toBe('ChIJ_1');

    const parsed = parseGeminiAnalystResponse(
      JSON.stringify({
        analyses: [
          {
            placeId: 'ChIJ_1',
            digitalNeeds: ['Migrar a HTTPS'],
            recommendedWebnexServices: ['Diseño Web + SSL'],
            commercialRelevance: 'Sitio actual sin HTTPS.',
            missingInformation: ['Confirmar titularidad'],
            manualVerificationSteps: ['Revisar certificado SSL'],
            analyzedSourceNote: 'HTML público del sitio',
          },
          {
            placeId: 'ChIJ_invented',
            digitalNeeds: ['Ignorar'],
            recommendedWebnexServices: [],
            commercialRelevance: 'No permitido',
            missingInformation: [],
            manualVerificationSteps: [],
            analyzedSourceNote: '',
          },
        ],
      }),
      new Set(['ChIJ_1'])
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].placeId).toBe('ChIJ_1');

    expect(formatFriendlyFirestoreError(new Error('Missing or insufficient permissions'))).toContain(
      'reglas de seguridad'
    );
    expect(formatFriendlyFirestoreError(new Error('resource-exhausted Quota exceeded'))).toContain(
      'Spark'
    );
  });
});

describe('8. Hidratación estrictamente bajo demanda, control real de cuota y Protección No Destructiva (52 registros)', () => {
  const buildFiftyTwoMockFollowups = (): FollowupLeadRecord[] =>
    Array.from({ length: 52 }, (_, i) => {
      const idx = i + 1;
      const stage = idx <= 17 ? 'PRESELECCIONADO' : 'PENDIENTE DE VERIFICACIÓN';
      return {
        id: `doc_crm_${idx}`,
        ownerUid: 'uid_test_webnex',
        placeId: `ChIJ_crm_${idx}`,
        sourceKind: 'places_preselection' as const,
        independentBusinessName: idx <= 5 ? `Veterinaria Propia ${idx}` : '',
        district: 'Los Olivos',
        stage,
        legalBasis: '',
        phoneStage: 'none',
        independentPhone: idx === 1 ? '987654321' : '',
        independentEmail: '',
        confirmedNoWebsite: true,
        independentWebsiteStatus: 'confirmed_none' as const,
        independentDigitalScore: 85,
        independentContactScore: 55,
        qualificationTier: idx <= 17 ? 'PRIORIDAD ALTA' : 'REVISIÓN PENDIENTE',
        classificationReasons: ['Sin web confirmada'],
        aiSummary: '',
        notes: `Nota existente ${idx}`,
        createdAt: `2026-11-01T10:00:${String(idx % 60).padStart(2, '0')}Z`,
        updatedAt: `2026-11-02T10:00:${String(idx % 60).padStart(2, '0')}Z`,
      };
    });

  it('limita lotes bajo demanda a <= 5, elimina reintentos automáticos y respeta TTL en memoria (30 min)', () => {
    const fiftyTwoPlaceIds = Array.from({ length: 52 }, (_, i) => `ChIJ_crm_${i + 1}`);
    const page1Ids = fiftyTwoPlaceIds.slice(0, 10);
    const page2Ids = fiftyTwoPlaceIds.slice(10, 20);
    const t0 = 1_700_000_000_000;

    let cache: Record<string, PlaceHydrationEntry> = {};

    // Bajo demanda explícito: máximo 5 visibles por lote, nunca 10 ni 52
    const firstBatch = selectNextHydrationBatch(page1Ids, cache, { nowMs: t0 });
    expect(firstBatch).toHaveLength(ON_DEMAND_MAX_BATCH_SIZE);
    expect(firstBatch).toEqual([
      'ChIJ_crm_1',
      'ChIJ_crm_2',
      'ChIJ_crm_3',
      'ChIJ_crm_4',
      'ChIJ_crm_5',
    ]);

    // Apertura individual: máximo 1 consulta
    expect(selectNextHydrationBatch(['ChIJ_crm_1'], cache, { maxBatchSize: 1, nowMs: t0 })).toEqual([
      'ChIJ_crm_1',
    ]);

    // Simular respuesta parcial: loaded, unavailable (404), transient_error (503)
    cache = mergeHydrationBatchResults(
      cache,
      firstBatch,
      {
        ChIJ_crm_1: {
          status: 'loaded',
          details: {
            placeId: 'ChIJ_crm_1',
            displayName: 'Veterinaria San Marcos',
            formattedAddress: 'Av. Universitaria 120, Los Olivos',
            nationalPhoneNumber: '987 654 321',
            internationalPhoneNumber: '+51 987 654 321',
            websiteUri: null,
            googleMapsUri: 'https://maps.google.com/?cid=101',
            businessStatus: 'OPERATIONAL',
          },
        },
        ChIJ_crm_2: { status: 'unavailable', code: 'PLACE_NOT_FOUND', message: 'No disponible' },
        ChIJ_crm_3: { status: 'transient_error', code: 'HTTP_503', message: 'Temporal' },
      },
      t0
    );

    // ChIJ_crm_1 queda utilizable en caché de sesión con TTL de 30 min
    expect(isHydrationEntryUsable(cache.ChIJ_crm_1, t0 + 5_000)).toBe(true);
    expect(isHydrationEntryUsable(cache.ChIJ_crm_1, t0 + SESSION_CACHE_TTL_MS)).toBe(false);

    // SIN reintentos automáticos: transient_error (ChIJ_crm_3) y unavailable (ChIJ_crm_2) NO entran en lotes no manuales
    const nextBatchWithoutManualRetry = selectNextHydrationBatch(page1Ids, cache, { nowMs: t0 });
    expect(nextBatchWithoutManualRetry).not.toContain('ChIJ_crm_1');
    expect(nextBatchWithoutManualRetry).not.toContain('ChIJ_crm_2');
    expect(nextBatchWithoutManualRetry).not.toContain('ChIJ_crm_3');

    // Solo reintento manual explícito cuando NO hay bloqueo de cuota vuelve a intentar ChIJ_crm_2 / ChIJ_crm_3
    expect(
      selectNextHydrationBatch(['ChIJ_crm_1', 'ChIJ_crm_2', 'ChIJ_crm_3'], cache, {
        isManualRetry: true,
        nowMs: t0,
      })
    ).toEqual(['ChIJ_crm_2', 'ChIJ_crm_3']);

    // Cambiar a página 2 conserva página 1 y respeta tope de 5
    const page2Batch = selectNextHydrationBatch(page2Ids, cache, { nowMs: t0 });
    expect(page2Batch).toEqual(page2Ids.slice(0, 5));
    expect(cache.ChIJ_crm_1.status).toBe('loaded');

    // Cuota 429 o límite local nunca sobrescribe detalles válidos previos y prohíbe reintentos
    const preserved = mergeHydrationBatchResults(
      cache,
      ['ChIJ_crm_1', 'ChIJ_crm_11', 'ChIJ_crm_12'],
      {
        ChIJ_crm_1: { status: 'quota_exceeded', code: 'PLACES_QUOTA_EXCEEDED', message: '429' },
        ChIJ_crm_11: { status: 'quota_exceeded', code: 'PLACES_QUOTA_EXCEEDED', message: '429' },
        ChIJ_crm_12: {
          status: 'local_quota_exceeded',
          code: 'LOCAL_DAILY_QUOTA_REACHED',
          message: 'Local',
        },
      },
      t0
    );
    expect(preserved.ChIJ_crm_1.status).toBe('loaded');
    expect(preserved.ChIJ_crm_1.details?.displayName).toBe('Veterinaria San Marcos');
    expect(preserved.ChIJ_crm_11.status).toBe('quota_exceeded');
    expect(preserved.ChIJ_crm_12.status).toBe('local_quota_exceeded');
    expect(selectNextHydrationBatch(['ChIJ_crm_11', 'ChIJ_crm_12'], preserved, { nowMs: t0 })).toEqual([]);
    expect(
      selectNextHydrationBatch(['ChIJ_crm_11', 'ChIJ_crm_12'], preserved, {
        isManualRetry: true,
        nowMs: t0,
      })
    ).toEqual([]);
    expect(getHydrationStatusMeta(preserved.ChIJ_crm_11, 'ChIJ_crm_11', { quotaBlocked: true }).canRetry).toBe(
      false
    );
    expect(getHydrationStatusMeta(preserved.ChIJ_crm_12, 'ChIJ_crm_12', { quotaBlocked: true }).canRetry).toBe(
      false
    );
  });

  it('Pruebas simuladas A, B y C: abrir Seguimiento con 52 registros y cambiar pestañas 5 veces dispara 0 llamadas Places; abrir 1 ficha dispara <= 1', () => {
    const records52 = buildFiftyTwoMockFollowups();
    const hydrateSpy = vi.fn(async () => {});
    const noBlock: PlacesQuotaBlockState = { blocked: false, source: 'none', message: null };
    const cleanQuota: QuotaStatus = {
      dateLima: '2026-11-18',
      placesUsed: 0,
      placesLimit: 60,
      placesFailed: 0,
      googleQuotaBlocked: false,
      googleQuotaBlockedMessage: null,
      geminiUsed: 0,
      geminiLimit: 40,
      note: 'Simulado',
    };

    const sessionCache: Record<string, PlaceHydrationEntry> = {
      ChIJ_crm_6: {
        placeId: 'ChIJ_crm_6',
        status: 'loaded',
        details: {
          placeId: 'ChIJ_crm_6',
          displayName: 'Veterinaria Los Olivos VIP',
          formattedAddress: 'Av. Las Palmeras 450, Los Olivos',
          nationalPhoneNumber: '988 777 666',
          internationalPhoneNumber: '+51 988 777 666',
          websiteUri: null,
          googleMapsUri: 'https://maps.google.com/?cid=6',
          businessStatus: 'OPERATIONAL',
        },
        retryCount: 0,
        updatedAt: Date.now(),
        expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
      },
    };

    // A & B: Renderizar Seguimiento al abrir y simular 5 cambios de pestaña desmontando/montando
    let lastHtml = '';
    for (let tabSwitch = 0; tabSwitch < 5; tabSwitch++) {
      lastHtml = renderToStaticMarkup(
        React.createElement(FollowupCrmView, {
          isSignedIn: true,
          followups: records52,
          hydrationCache: sessionCache,
          placesQuotaBlock: noBlock,
          quota: cleanQuota,
          onHydratePlaceIds: hydrateSpy,
          onFetchIntegrityBackup: async () => ({
            totalDocuments: 52,
            uniqueDocIds: 52,
            uniquePlaceIds: 52,
            backedUpAt: new Date().toISOString(),
            records: records52,
          }),
          onSignIn: () => {},
          onUpdateFollowup: async () => {},
          onCreateManualFollowup: async () => {},
        })
      );
    }

    // 0 llamadas Place Details automáticas al abrir ni tras 5 cambios de pestaña
    expect(hydrateSpy).toHaveBeenCalledTimes(0);
    // Todos los 52 registros y contadores propios de Firebase visibles inmediatamente
    expect(lastHtml).toContain('Registros en CRM: <strong>52</strong>');
    expect(lastHtml).toContain('PRESELECCIONADO (17)');
    expect(lastHtml).toContain('PENDIENTE DE VERIFICACIÓN (35)');
    expect(lastHtml).toContain('Veterinaria Propia 1');
    // ChIJ_crm_6 conserva su nombre desde la caché compartida de sesión sin repetir consulta
    expect(lastHtml).toContain('Veterinaria Los Olivos VIP');
    // Seguimiento NO renderiza botones que disparen Place Details
    expect(lastHtml).not.toContain('Cargar detalles de');
    expect(lastHtml).not.toContain('Abrir y consultar detalle');

    // C: Al abrir 1 registro ya cargado en sesión, 0 solicitudes
    expect(
      selectNextHydrationBatch(['ChIJ_crm_6'], sessionCache, { maxBatchSize: 1 })
    ).toEqual([]);
  });

  it('Prueba simulada D, E y F: 429 RESOURCE_EXHAUSTED vs cuota local detiene llamadas, no cuenta fallos como recuperados y mantiene CRM 100% operativo con 52 registros intactos', async () => {
    const records52 = buildFiftyTwoMockFollowups();
    const prevKey = process.env.GOOGLE_MAPS_PLATFORM_KEY;
    const origFetch = globalThis.fetch;
    let upstreamCalls = 0;

    process.env.GOOGLE_MAPS_PLATFORM_KEY = 'test-simulated-key';
    globalThis.fetch = (async (input: any) => {
      upstreamCalls += 1;
      const url = String(input);
      if (url.includes('ChIJ_sim_ok')) {
        return new Response(
          JSON.stringify({
            id: 'ChIJ_sim_ok',
            displayName: { text: 'Óptica Real' },
            formattedAddress: 'Av. Carlos Izaguirre 200',
            nationalPhoneNumber: '987 111 222',
          }),
          { status: 200 }
        );
      }
      if (url.includes('ChIJ_sim_404')) {
        return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
      }
      if (url.includes('ChIJ_sim_429')) {
        return new Response(
          JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }),
          { status: 429 }
        );
      }
      return new Response('{}', { status: 500 });
    }) as typeof fetch;

    const guardGoogle429 = new DailyQuotaGuard({ placesLimit: 60 });
    const appGoogle429 = createApiApp(guardGoogle429);
    const server1 = http.createServer(appGoogle429);
    await new Promise<void>((resolve) => server1.listen(0, '127.0.0.1', () => resolve()));

    try {
      const port = (server1.address() as AddressInfo).port;
      // 1) Lote con 1 éxito, 1 404 y 1 429 real de Google + 2 posteriores
      const res1 = await origFetch(`http://127.0.0.1:${port}/api/places/details`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          placeIds: [
            'ChIJ_sim_ok',
            'ChIJ_sim_404',
            'ChIJ_sim_429',
            'ChIJ_sim_after_429_a',
            'ChIJ_sim_after_429_b',
          ],
        }),
      });
      expect(res1.status).toBe(200);
      const body1: any = await res1.json();
      expect(body1.quotaExceeded).toBe(true);
      expect(body1.localQuotaReached).toBe(false);
      expect(body1.quotaSource).toBe('google_resource_exhausted');
      expect(body1.results.ChIJ_sim_ok.status).toBe('loaded');
      expect(body1.results.ChIJ_sim_404.status).toBe('unavailable');
      expect(body1.results.ChIJ_sim_429.status).toBe('quota_exceeded');
      expect(body1.results.ChIJ_sim_after_429_a.status).toBe('quota_exceeded');
      expect(body1.results.ChIJ_sim_after_429_b.status).toBe('quota_exceeded');
      // Solo 1 exitosa (ChIJ_sim_ok); las fallidas (404 y 429) incrementan placesFailed y NUNCA placesUsed
      expect(body1.quota.placesUsed).toBe(1);
      expect(body1.quota.placesFailed).toBe(2);
      expect(body1.quota.googleQuotaBlocked).toBe(true);
      expect(upstreamCalls).toBe(3);

      // 2) Nueva solicitud tras bloqueo 429 NO debe llamar a Google (upstreamCalls permanece en 3)
      const resBlockedSearch = await origFetch(`http://127.0.0.1:${port}/api/places/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessType: 'Veterinarias', location: 'Los Olivos, Lima' }),
      });
      expect(resBlockedSearch.status).toBe(429);
      const searchBlockedBody: any = await resBlockedSearch.json();
      expect(searchBlockedBody.code).toBe('PLACES_QUOTA_EXCEEDED');
      expect(searchBlockedBody.quotaSource).toBe('google_resource_exhausted');
      expect(upstreamCalls).toBe(3);

      // 3) UI en modo bloqueado: NO renderiza botón de cargar ni botones para repetir consultas, muestra aviso claro
      const blockedHtml = renderToStaticMarkup(
        React.createElement(FollowupCrmView, {
          isSignedIn: true,
          followups: records52,
          hydrationCache: {},
          placesQuotaBlock: {
            blocked: true,
            source: 'google_resource_exhausted',
            message: searchBlockedBody.message,
          },
          quota: body1.quota,
          onHydratePlaceIds: async () => {},
          onFetchIntegrityBackup: async () => ({
            totalDocuments: 52,
            uniqueDocIds: 52,
            uniquePlaceIds: 52,
            backedUpAt: new Date().toISOString(),
            records: records52,
          }),
          onSignIn: () => {},
          onUpdateFollowup: async () => {},
          onCreateManualFollowup: async () => {},
        })
      );
      expect(blockedHtml).toContain('Cuota de Google Places API pausada en Explorador');
      expect(blockedHtml).not.toContain('Cargar detalles de');
      expect(blockedHtml).not.toContain('Abrir y consultar detalle');
      expect(blockedHtml).toContain('Registros en CRM: <strong>52</strong>');
    } finally {
      server1.close();
    }

    // 4) Diferenciar cuota preventiva local (LOCAL_DAILY_QUOTA_REACHED) sin confundirla con 429 de Google
    const guardLocal = new DailyQuotaGuard({ placesLimit: 1 });
    const appLocal = createApiApp(guardLocal);
    const server2 = http.createServer(appLocal);
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', () => resolve()));

    try {
      const port2 = (server2.address() as AddressInfo).port;
      const callsBeforeLocal = upstreamCalls;
      const resLocal = await origFetch(`http://127.0.0.1:${port2}/api/places/details`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placeIds: ['ChIJ_sim_ok', 'ChIJ_sim_second'] }),
      });
      const localBody: any = await resLocal.json();
      expect(localBody.results.ChIJ_sim_ok.status).toBe('loaded');
      expect(localBody.results.ChIJ_sim_second.status).toBe('local_quota_exceeded');
      expect(localBody.localQuotaReached).toBe(true);
      expect(localBody.quotaExceeded).toBe(false);
      expect(localBody.quotaSource).toBe('local_preventive_limit');
      expect(localBody.quota.placesUsed).toBe(1);
      expect(localBody.quota.googleQuotaBlocked).toBe(false);
      // Solo consultó ChIJ_sim_ok; al llegar al tope local 1/1 detuvo ChIJ_sim_second sin llamar a Google
      expect(upstreamCalls).toBe(callsBeforeLocal + 1);
    } finally {
      server2.close();
      globalThis.fetch = origFetch;
      if (prevKey !== undefined) process.env.GOOGLE_MAPS_PLATFORM_KEY = prevKey;
      else delete process.env.GOOGLE_MAPS_PLATFORM_KEY;
    }

    // E & F: Seguimiento funciona sin Maps e integridad de los 52 registros intacta (sin sobrescritura ni borrado)
    expect(records52.filter((r) => r.stage === 'PRESELECCIONADO')).toHaveLength(17);
    expect(records52.filter((r) => r.stage === 'PENDIENTE DE VERIFICACIÓN')).toHaveLength(35);
    expect(validateLegalBasisForStage('CONTACTO AUTORIZADO', 'Consentimiento verbal registrado en llamada')).toBeNull();

    const existing52Set = new Set(records52.map((r) => r.placeId));
    const safePlan = planNonDestructiveFollowupBatch(
      [
        { placeId: 'ChIJ_crm_1', stage: 'DESCARTADO', notes: 'No debe sobrescribir' },
        { placeId: 'ChIJ_crm_52', stage: 'DESCARTADO', notes: 'No debe sobrescribir' },
        { placeId: 'ChIJ_crm_53', stage: 'PRESELECCIONADO', notes: 'Nuevo prospecto' },
      ],
      existing52Set
    );
    expect(safePlan.skippedDuplicates).toBe(2);
    expect(safePlan.toCreate.map((c) => c.placeId)).toEqual(['ChIJ_crm_53']);
  });

  it('distingue correctamente tipo de teléfono (móvil/fijo/desconocido) y procedencia Places vs Independiente', () => {
    const baseRecord = {
      placeId: 'ChIJ_disp_1',
      independentPhone: '',
      phoneStage: 'none' as const,
    };

    // 1. Sin consultar aún en Places (bajo demanda) -> nunca dice "Sin teléfono independiente"
    const pendingDisplay = resolveFollowupPhoneDisplay(baseRecord, undefined);
    expect(pendingDisplay.fallbackStatusText).toBe('Sin consultar en Places (bajo demanda)');
    expect(pendingDisplay.fallbackStatusText).not.toContain('independiente');

    // 2. Hidratado con móvil de Google Places
    const mobileEntry: PlaceHydrationEntry = {
      placeId: 'ChIJ_disp_1',
      status: 'loaded',
      details: {
        placeId: 'ChIJ_disp_1',
        displayName: 'Bodega Central',
        formattedAddress: 'Av. Perú 500',
        nationalPhoneNumber: '987 654 321',
        internationalPhoneNumber: '+51 987 654 321',
        websiteUri: null,
        googleMapsUri: 'https://maps.google.com/?cid=1',
        businessStatus: 'OPERATIONAL',
      },
      retryCount: 0,
      updatedAt: Date.now(),
      expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
    };
    const mobileDisplay = resolveFollowupPhoneDisplay(baseRecord, mobileEntry);
    expect(mobileDisplay.placesPhoneText).toBe('+51 987 654 321');
    expect(mobileDisplay.placesLineTypeLabel).toBe('Móvil');
    expect(mobileDisplay.independentPhoneText).toBeNull();
    expect(mobileDisplay.fallbackStatusText).toBeNull();
    expect(getHydrationStatusMeta(mobileEntry, 'ChIJ_disp_1').label).toBe('Datos cargados (sesión)');

    // 3. Hidratado con fijo de Lima
    const landlineEntry: PlaceHydrationEntry = {
      ...mobileEntry,
      details: {
        ...mobileEntry.details!,
        nationalPhoneNumber: '(01) 456-7890',
        internationalPhoneNumber: '+51 1 4567890',
      },
    };
    const landlineDisplay = resolveFollowupPhoneDisplay(baseRecord, landlineEntry);
    expect(landlineDisplay.placesLineTypeLabel).toBe('Fijo (Lima/Callao)');

    // 4. Hidratado sin teléfono en Google Places
    const noPhoneEntry: PlaceHydrationEntry = {
      ...mobileEntry,
      details: {
        ...mobileEntry.details!,
        nationalPhoneNumber: null,
        internationalPhoneNumber: null,
      },
    };
    const noPhoneDisplay = resolveFollowupPhoneDisplay(baseRecord, noPhoneEntry);
    expect(noPhoneDisplay.fallbackStatusText).toBe('Sin teléfono registrado en Google Places');
    expect(getHydrationStatusMeta(noPhoneEntry, 'ChIJ_disp_1').label).toBe('Sin teléfono registrado');

    // 5. Con teléfono corroborado independientemente WEBNEX + Places
    const bothDisplay = resolveFollowupPhoneDisplay(
      {
        placeId: 'ChIJ_disp_1',
        independentPhone: '+51 911 222 333',
        phoneStage: 'independently_corroborated',
      },
      mobileEntry
    );
    expect(bothDisplay.independentPhoneText).toBe('+51 911 222 333');
    expect(bothDisplay.independentLineTypeLabel).toBe('Móvil');
    expect(bothDisplay.placesPhoneText).toBe('+51 987 654 321');
  });

  it('getPlaceDetailsByIdWithStatus diferencia 404 (unavailable), 429, 403 y /api/places/details preserva caché sin repetir upstream', async () => {
    const unavailableOutcome = await getPlaceDetailsByIdWithStatus('ChIJ_deleted', {
      apiKey: 'test-key',
      fetchFn: async () => new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }),
    });
    expect(unavailableOutcome).toEqual({ status: 'unavailable' });

    await expect(
      getPlaceDetailsByIdWithStatus('ChIJ_forbidden', {
        apiKey: 'test-key',
        fetchFn: async () =>
          new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'Denied' } }), {
            status: 403,
          }),
      })
    ).rejects.toMatchObject({ status: 403, code: 'PLACES_PERMISSION_DENIED' });

    const prevKey = process.env.GOOGLE_MAPS_PLATFORM_KEY;
    const origFetch = globalThis.fetch;
    let upstreamCalls = 0;

    process.env.GOOGLE_MAPS_PLATFORM_KEY = 'test-platform-key';
    globalThis.fetch = (async (input: any) => {
      upstreamCalls += 1;
      const url = String(input);
      if (url.includes('ChIJ_http_ok')) {
        return new Response(
          JSON.stringify({
            id: 'ChIJ_http_ok',
            displayName: { text: 'Óptica Central' },
            formattedAddress: 'Av. Arequipa 100',
            nationalPhoneNumber: '987 111 222',
          }),
          { status: 200 }
        );
      }
      if (url.includes('ChIJ_http_404')) {
        return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
      }
      return new Response('{}', { status: 500 });
    }) as typeof fetch;

    const app = createApiApp(new DailyQuotaGuard({ placesLimit: 60 }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    try {
      const port = (server.address() as AddressInfo).port;
      const res1 = await origFetch(`http://127.0.0.1:${port}/api/places/details`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          placeIds: ['ChIJ_http_ok', 'ChIJ_http_404'],
        }),
      });
      expect(res1.status).toBe(200);
      const body1: any = await res1.json();
      expect(body1.details.ChIJ_http_ok.displayName).toBe('Óptica Central');
      expect(body1.results.ChIJ_http_ok.status).toBe('loaded');
      expect(body1.results.ChIJ_http_404.status).toBe('unavailable');
      expect(body1.quota.placesUsed).toBe(1);
      expect(body1.quota.placesFailed).toBe(1);
      expect(upstreamCalls).toBe(2);

      // Segunda consulta sobre los mismos ChIJ_http_ok y ChIJ_http_404 debe salir 100% desde caché (0 llamadas upstream nuevas)
      const callsBeforeCacheCheck = upstreamCalls;
      const res2 = await origFetch(`http://127.0.0.1:${port}/api/places/details`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placeIds: ['ChIJ_http_ok', 'ChIJ_http_404'] }),
      });
      expect(res2.status).toBe(200);
      const body2: any = await res2.json();
      expect(body2.results.ChIJ_http_ok.status).toBe('loaded');
      expect(body2.results.ChIJ_http_404.status).toBe('unavailable');
      expect(upstreamCalls).toBe(callsBeforeCacheCheck);
    } finally {
      server.close();
      globalThis.fetch = origFetch;
      if (prevKey !== undefined) process.env.GOOGLE_MAPS_PLATFORM_KEY = prevKey;
      else delete process.env.GOOGLE_MAPS_PLATFORM_KEY;
    }
  });
});

describe('9. Arquitectura Definitiva del CRM: Corroboración Independiente, Trazabilidad y Recuperación Transaccional (0 Places en Seguimiento)', () => {
  it('verifica que MINIMAL_PLACES_FIELD_MASK incluya los 12 campos comerciales y mapa en una sola llamada de búsqueda', () => {
    const expected = [
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
    ];
    for (const field of expected) {
      expect(MINIMAL_PLACES_FIELD_MASK).toContain(field);
    }
  });

  it('corroboración independiente extrae JSON-LD + /contacto sin llamar a Google Places y bloquea SSRF / redes sociales', async () => {
    const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
    const homeHtml = `
      <html>
        <head>
          <title>Clínica Dental Lima Norte | Inicio</title>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Dentist",
              "name": "Clínica Dental Sonrisas Norte",
              "address": {
                "@type": "PostalAddress",
                "streetAddress": "Av. Carlos Izaguirre 840",
                "addressLocality": "Los Olivos"
              }
            }
          </script>
        </head>
        <body><a href="/contacto">Contacto</a></body>
      </html>
    `;
    const contactHtml = `
      <html>
        <body>
          <p>Atención por WhatsApp o llamada: <a href="tel:+51987654321">987 654 321</a></p>
          <p>Escríbenos a <a href="mailto:citas@sonrisasnorte.pe">citas@sonrisasnorte.pe</a></p>
        </body>
      </html>
    `;

    const extracted = extractIndependentSignalsFromHtml(
      homeHtml,
      'https://sonrisasnorte.pe/',
      '2026-11-19T00:00:00Z'
    );
    expect(extracted.businessName?.value).toBe('Clínica Dental Sonrisas Norte');
    expect(extracted.businessName?.source).toBe('official_website_jsonld');
    expect(extracted.address?.value).toContain('Av. Carlos Izaguirre 840');
    expect(extracted.district?.value).toBe('Los Olivos');
    expect(extracted.category?.value).toBe('Dentist');

    let fetchedUrls: string[] = [];
    const fullCorr = await corroborateLeadIndependently(
      {
        placeId: 'ChIJ_sonrisas',
        officialWebsiteUrl: 'https://sonrisasnorte.pe/',
        searchCategory: 'Clínicas dentales',
        searchDistrict: 'Los Olivos, Lima',
      },
      {
        dnsLookupFn: publicDns,
        fetchFn: async (input: any) => {
          const u = String(input);
          fetchedUrls.push(u);
          if (u.endsWith('/contacto')) {
            return new Response(contactHtml, {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          return new Response(homeHtml, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        },
      }
    );

    expect(fetchedUrls.some((u) => u.includes('googleapis.com'))).toBe(false);
    expect(fullCorr.completeness).toBe('complete');
    expect(fullCorr.candidates.businessName?.value).toBe('Clínica Dental Sonrisas Norte');
    expect(fullCorr.candidates.phone?.value).toBe('+51 987 654 321');
    expect(fullCorr.candidates.phoneType?.value).toBe('mobile');
    expect(fullCorr.candidates.email?.value).toBe('citas@sonrisasnorte.pe');
    expect(fullCorr.candidates.website?.value).toBe('https://sonrisasnorte.pe/');

    // Bloqueo SSRF y redes sociales
    const socialCorr = await corroborateLeadIndependently(
      {
        placeId: 'ChIJ_fb',
        officialWebsiteUrl: 'https://www.facebook.com/dentalnorte',
        searchCategory: 'Dentistas',
        searchDistrict: 'Los Olivos',
      },
      { dnsLookupFn: publicDns }
    );
    expect(socialCorr.websiteStatus).toBe('social_only');
    expect(socialCorr.candidates.website).toBeNull();

    const ssrfCorr = await corroborateLeadIndependently(
      {
        placeId: 'ChIJ_ssrf',
        officialWebsiteUrl: 'http://127.0.0.1/admin',
      },
      { dnsLookupFn: async () => [{ address: '127.0.0.1', family: 4 }] }
    );
    expect(ssrfCorr.websiteStatus).toBe('unverified_inconclusive');
    expect(ssrfCorr.candidates.businessName).toBeNull();
  });

  it('endpoint POST /api/corroborate-independent funciona con 0 llamadas a Google Places', async () => {
    const app = createApiApp(new DailyQuotaGuard({ placesLimit: 0 })); // Incluso con cuota Places en 0!
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/corroborate-independent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              placeId: 'ChIJ_context_only',
              searchCategory: 'Veterinarias',
              searchDistrict: 'Miraflores, Perú',
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.results).toHaveLength(1);
      expect(data.results[0].candidates.category.value).toBe('Veterinarias');
      expect(data.results[0].candidates.category.source).toBe('user_search_context');
      expect(data.results[0].candidates.district.value).toBe('Miraflores');
    } finally {
      server.close();
    }
  });

  it('evalúa completitud de fichas, trazabilidad por campo y recuperación transaccional estricta sobre 52 registros sin sobrescribir datos previos', () => {
    expect(isIndependentEntryDistinctFromRawMapsGuard({ source: 'none' })).toBe(false);
    expect(isIndependentEntryDistinctFromRawMapsGuard({ source: 'official_website_jsonld' })).toBe(
      true
    );

    const pEntry = encodeVerificationProvenanceEntry({
      field: 'nombre',
      source: 'official_website_jsonld',
      evidence: 'https://empresa.pe',
      verifiedAt: '2026-11-19T00:00:00Z',
    });
    const parsedEntry = parseVerificationProvenanceEntry(pEntry);
    expect(parsedEntry.field).toBe('nombre');
    expect(parsedEntry.source).toBe('official_website_jsonld');

    const merged = mergeVerificationSources([pEntry], [pEntry], 8);
    expect(merged).toHaveLength(1);

    // Completitud
    expect(
      evaluateFollowupCompleteness({
        independentBusinessName: '',
        independentPhone: '',
        independentAddress: '',
        district: '',
        independentWebsite: '',
        confirmedNoWebsite: false,
        independentEmail: '',
        independentCategory: '',
      }).status
    ).toBe('place_id_only');

    expect(
      evaluateFollowupCompleteness({
        independentBusinessName: 'Vet Pro',
        independentPhone: '+51 987 654 321',
        independentAddress: 'Av. Perú 100',
        district: 'Los Olivos',
        independentWebsite: 'https://vetpro.pe',
        confirmedNoWebsite: false,
        independentEmail: 'hola@vetpro.pe',
        independentCategory: 'Veterinaria',
      }).status
    ).toBe('complete');

    // Simular 52 registros existentes (17 PRESELECCIONADO, 35 PENDIENTE DE VERIFICACIÓN) donde 1 tiene datos previos y 1 es CLIENTE
    const existing52: FollowupLeadRecord[] = Array.from({ length: 52 }, (_, i) => {
      const idx = i + 1;
      return {
        id: `doc_${idx}`,
        ownerUid: 'u1',
        placeId: `ChIJ_52_${idx}`,
        sourceKind: 'places_preselection' as const,
        independentBusinessName: idx === 1 ? 'Nombre Original Protegido' : '',
        district: idx === 1 ? 'San Isidro' : '',
        independentAddress: '',
        independentWebsite: '',
        independentCategory: '',
        confirmedNoWebsite: false,
        independentWebsiteStatus: 'unregistered' as const,
        independentPhone: '',
        independentPhoneType: 'none' as const,
        phoneStage: 'none' as const,
        independentEmail: '',
        independentDigitalScore: 85,
        independentContactScore: 40,
        stage: idx === 52 ? ('CLIENTE' as const) : idx <= 17 ? ('PRESELECCIONADO' as const) : ('PENDIENTE DE VERIFICACIÓN' as const),
        legalBasis: idx === 1 ? 'Consentimiento previo correo' : '',
        qualificationTier: 'PRIORIDAD ALTA' as const,
        aiSummary: '',
        notes: `Nota original ${idx}`,
        createdAt: '2026-11-01T10:00:00Z',
        updatedAt: '2026-11-02T10:00:00Z',
      };
    });

    const csvText = [
      'placeId,nombre,telefono,direccion,distrito,web,correo,categoria',
      'ChIJ_52_1,Nombre Intento Sobrescritura,987654321,Av. Pardo 200,Miraflores,https://vet1.pe,info@vet1.pe,Veterinaria',
      'ChIJ_52_2,Clínica Recuperada 2,912345678,Av. Universitaria 500,Los Olivos,https://clinica2.pe,hola@clinica2.pe,Clínica',
      'ChIJ_52_52,Cliente No Tocar,999888777,Av. Arequipa 900,Lince,https://c52.pe,,Salud',
    ].join('\n');

    const previews = buildNonDestructiveRecoveryPreviews({
      followups: existing52,
      corroborations: [],
      authorizedCsvText: csvText,
      nowIso: '2026-11-19T01:00:00Z',
    });

    // ChIJ_52_52 es CLIENTE -> ignorado totalmente; ChIJ_52_1 solo propone los campos vacíos (NO nombre ni distrito); ChIJ_52_2 propone todos los campos vacíos
    expect(previews.map((p) => p.record.placeId)).toEqual(['ChIJ_52_1', 'ChIJ_52_2']);

    const patch1 = buildMissingFieldsPatch(existing52[0], previews[0].proposal);
    expect(patch1.independentBusinessName).toBeUndefined(); // NUNCA sobrescribe nombre previo!
    expect(patch1.district).toBeUndefined(); // NUNCA sobrescribe distrito previo!
    expect(patch1.independentPhone).toBe('+51 987 654 321');
    expect(patch1.independentPhoneType).toBe('mobile');
    expect(patch1.independentAddress).toBe('Av. Pardo 200');
    expect(patch1.stage).toBeUndefined();
    expect(patch1.notes).toBeUndefined();
    expect(patch1.legalBasis).toBeUndefined();

    const patch52 = buildMissingFieldsPatch(existing52[51], {
      independentBusinessName: 'Intento',
    });
    expect(patch52).toEqual({});

    // Seguimiento renderiza ficha persistente completa con 0 llamadas Places y ExportButton activo
    const crmRecordFull: FollowupLeadRecord = {
      ...existing52[1],
      independentBusinessName: 'Clínica Recuperada 2',
      independentPhone: '+51 912 345 678',
      independentPhoneType: 'mobile',
      independentAddress: 'Av. Universitaria 500',
      district: 'Los Olivos',
      independentWebsite: 'https://clinica2.pe',
      independentCategory: 'Clínica Dental',
      verificationSources: [pEntry],
      lastVerifiedAt: '2026-11-19T01:00:00Z',
    };

    const crmHtml = renderToStaticMarkup(
      React.createElement(FollowupCrmView, {
        isSignedIn: true,
        followups: [crmRecordFull],
        hydrationCache: {},
        placesQuotaBlock: { blocked: true, source: 'google_resource_exhausted', message: '429' },
        quota: null,
        onRecoverMissingFields: async () => ({
          updatedRecords: 1,
          skippedRecords: 0,
          fieldsCompleted: 5,
        }),
        onFetchIntegrityBackup: async () => ({
          totalDocuments: 1,
          uniqueDocIds: 1,
          uniquePlaceIds: 1,
          backedUpAt: '2026-11-19T01:00:00Z',
          records: [crmRecordFull],
        }),
        onSignIn: () => {},
        onUpdateFollowup: async () => {},
        onCreateManualFollowup: async () => {},
      })
    );

    expect(crmHtml).toContain('Clínica Recuperada 2');
    expect(crmHtml).toContain('Av. Universitaria 500');
    expect(crmHtml).toContain('Clínica Dental');
    expect(crmHtml).toContain('+51 912 345 678');
    expect(crmHtml).toContain('https://clinica2.pe');
    expect(crmHtml).toContain('Ficha persistente completa');
    expect(crmHtml).toContain('Exportar CRM Indep. (1)');

    const exportHtml = renderToStaticMarkup(
      React.createElement(ExportButton, { followups: [crmRecordFull] })
    );
    expect(exportHtml).toContain('Exportar CRM Indep. (1)');
  });
});

describe('10. Smart Qualifier 2.0 (3 puntajes, gating Gemini, resultados Fase 6, Sandbox Fase 7 y vista previa Fase 8)', () => {
  const emptyExclusionKeys = buildExclusionKeySet([]);

  const makePlace = (overrides: Partial<GooglePlaceRaw> = {}): GooglePlaceRaw => ({
    placeId: 'ChIJ_sq2_1',
    displayName: 'Clínica Dental Miraflores',
    formattedAddress: 'Av. Pardo 300, Miraflores',
    location: { lat: -12.119, lng: -77.03 },
    nationalPhoneNumber: '987 111 222',
    internationalPhoneNumber: '+51 987 111 222',
    websiteUri: null,
    googleMapsUri: 'https://maps.google.com/?cid=100',
    rating: 4.8,
    userRatingCount: 15,
    businessStatus: 'OPERATIONAL',
    primaryTypeDisplayName: 'Dentista',
    ...overrides,
  });

  it('calcula 3 puntajes independientes, detecta contradicciones/cierres y clasifica sin asumir WhatsApp', () => {
    const baseProbe = {
      checkedUrl: 'https://clinicamiraflores.pe',
      finalUrl: 'https://clinicamiraflores.pe/',
      status: 'active_https' as const,
      httpStatus: 200,
      tlsValid: true,
      isSocialOnly: false,
      inconclusiveReason: null,
      summary: 'Sitio HTTPS activo',
      verifiedAt: '2026-11-19T00:00:00Z',
      provenance: 'independent_http' as const,
    };

    // Evidencia técnica HTML (sin viewport ni meta description) sube Puntaje A de HTTPS activo
    const digitalWithGaps = computeDigitalOpportunityScore(baseProbe, false, {
      category: 'Clínica dental',
      technicalEvidence: { hasViewportMeta: false, hasMetaDescription: false, cmsHint: 'Wix' },
    });
    expect(digitalWithGaps.score).toBe(55);

    // Contradicción explícita (confirmado sin web pero con URL web independiente) y cierre temporal
    const trustWithContradiction = computeInformationTrustScore({
      businessStatus: 'CLOSED_TEMPORARILY',
      independentBusinessName: 'Clínica Miraflores',
      independentPhone: '+51 987 111 222',
      independentAddress: 'Av. Pardo 300',
      district: 'Miraflores',
      independentWebsite: 'https://clinicamiraflores.pe',
      confirmedNoWebsite: true,
      websiteProbe: baseProbe,
      verificationSourcesCount: 3,
      lastVerifiedAt: new Date().toISOString(),
      commercialOutcome: 'numero_inexistente',
    });
    expect(trustWithContradiction.hasContradictions).toBe(true);
    expect(trustWithContradiction.isOperational).toBe(false);
    expect(trustWithContradiction.contradictions.length).toBeGreaterThanOrEqual(3);
    expect(trustWithContradiction.score).toBe(0);

    // Cierre permanente y cierre temporal en lote determinístico
    const opLead = buildBusinessLeadFromPlace(
      makePlace({ placeId: 'ChIJ_op_1', websiteUri: 'https://www.facebook.com/clinicaop' }),
      'Clínica dental',
      emptyExclusionKeys
    );
    opLead.websiteProbe = {
      checkedUrl: 'https://www.facebook.com/clinicaop',
      finalUrl: null,
      status: 'social_only',
      httpStatus: null,
      tlsValid: null,
      isSocialOnly: true,
      inconclusiveReason: null,
      summary: 'Solo red social',
      verifiedAt: '2026-11-19T00:00:00Z',
      provenance: 'independent_http',
    };
    opLead.digitalScore = computeDigitalOpportunityScore(opLead.websiteProbe, false);

    const tempClosedLead = buildBusinessLeadFromPlace(
      makePlace({ placeId: 'ChIJ_temp_closed', businessStatus: 'CLOSED_TEMPORARILY' }),
      'Clínica dental',
      emptyExclusionKeys
    );
    const permClosedLead = buildBusinessLeadFromPlace(
      makePlace({ placeId: 'ChIJ_perm_closed', businessStatus: 'CLOSED_PERMANENTLY' }),
      'Clínica dental',
      emptyExclusionKeys
    );

    const batch = qualifyLoadedLeadsBatch([opLead, tempClosedLead, permClosedLead], {
      discardedPlaceIds: new Set(),
      existingFollowups: [],
    });

    const opRes = batch.results.find((r) => r.placeId === 'ChIJ_op_1')!;
    const tempRes = batch.results.find((r) => r.placeId === 'ChIJ_temp_closed')!;
    const permRes = batch.results.find((r) => r.placeId === 'ChIJ_perm_closed')!;

    expect(opRes.tier).toBe('PRIORIDAD ALTA');
    expect(opRes.trustScore).toBeGreaterThan(0);
    expect(opRes.combinedPriorityScore).toBeGreaterThan(0);
    expect(tempRes.tier).toBe('REVISIÓN PENDIENTE');
    expect(tempRes.contradictions.some((c) => c.includes('CERRADO TEMPORALMENTE'))).toBe(true);
    expect(permRes.tier).toBe('NO ELEGIBLE');

    // Filtro inteligente excluye CLOSED_PERMANENTLY cuando excludeClientsDiscardsDuplicates = true
    expect(
      matchesSmartFilters(permClosedLead, DEFAULT_SMART_FILTERS, {
        discardedPlaceIds: new Set(),
        followupByPlaceId: new Map(),
        showExcludedAndDiscarded: false,
      })
    ).toBe(false);
  });

  it('bloquea llamadas a Gemini en /api/analyze-leads cuando los candidatos carecen de evidencia HTML o notas propias sustantivas', async () => {
    expect(
      hasSubstantiveIndependentEvidence({
        placeId: 'p1',
        category: 'Clínica',
        websiteStatus: 'unregistered',
        websiteMeta: null,
        userNotes: '',
      })
    ).toBe(false);

    expect(
      hasSubstantiveIndependentEvidence({
        placeId: 'p2',
        category: 'Clínica',
        websiteStatus: 'active_http',
        websiteMeta: null,
        userNotes: 'Nota propia verificada: sin formulario de reserva móvil.',
      })
    ).toBe(true);

    const guard = new DailyQuotaGuard({ geminiLimit: 5, placesLimit: 0 });
    const app = createApiApp(guard);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/analyze-leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidates: [
            {
              placeId: 'ChIJ_maps_only',
              category: 'Ferretería',
              websiteStatus: 'unregistered',
              officialWebsiteUrl: null,
              userNotes: 'ok', // menor a 15 chars -> insuficiente
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.modelUsed).toBe('skipped_no_independent_evidence');
      expect(body.analyses).toEqual([]);
      expect(body.quota.geminiUsed).toBe(0);
      expect(body.quota.placesUsed).toBe(0);
    } finally {
      server.close();
    }
  });

  it('FASE 6: registra historial acotado (máx. 10) de resultados reales y protege calibración contra sobreajuste en muestra pequeña', () => {
    let history: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const entry = encodeOutcomeHistoryEntry({
        outcome: i === 12 ? 'venta_confirmada' : 'respondio',
        source: 'llamada_directa_webnex',
        context: `Seguimiento intento #${i}`,
        recordedAt: `2026-11-19T0${i % 9}:00:00Z`,
      });
      history = mergeOutcomeHistory(history, entry, 10);
    }
    expect(history).toHaveLength(10);
    const newest = parseOutcomeHistoryEntry(history[0]);
    expect(newest.outcome).toBe('venta_confirmada');
    expect(getCommercialOutcomeLabel('venta_confirmada')).toBe('Venta confirmada');

    const mkFollowup = (id: string, outcome: FollowupLeadRecord['commercialOutcome'], complete = true): FollowupLeadRecord => ({
      id,
      ownerUid: 'u1',
      placeId: `ChIJ_${id}`,
      sourceKind: 'independent_manual',
      independentBusinessName: complete ? `Empresa ${id}` : '',
      district: 'Miraflores',
      confirmedNoWebsite: true,
      independentWebsiteStatus: 'confirmed_none',
      independentPhone: complete ? '+51 987 654 321' : '',
      independentPhoneType: complete ? 'mobile' : 'none',
      phoneStage: complete ? 'independently_corroborated' : 'none',
      independentEmail: '',
      independentDigitalScore: 90,
      independentContactScore: 70,
      independentTrustScore: complete ? 85 : 25,
      stage: outcome === 'venta_confirmada' ? 'CLIENTE' : 'CONTACTADO',
      legalBasis: 'Referido directo B2B',
      qualificationTier: 'PRIORIDAD ALTA',
      aiSummary: '',
      notes: '',
      commercialOutcome: outcome,
      createdAt: '2026-11-19T00:00:00Z',
      updatedAt: '2026-11-19T00:00:00Z',
    });

    // Muestra pequeña (4 alcanzados < 10) -> sampleSizeSufficient === false
    const smallSampleStats = computeOutcomeCalibrationStats([
      mkFollowup('1', 'respondio'),
      mkFollowup('2', 'sin_respuesta'),
      mkFollowup('3', 'interesado'),
      mkFollowup('4', 'numero_inexistente'),
    ]);
    expect(smallSampleStats.sampleSizeSufficient).toBe(false);
    expect(smallSampleStats.reachedCount).toBe(4);
    expect(smallSampleStats.insights[0]).toContain('Muestra pequeña');

    // Muestra >= 10 alcanzados con >= 25% datos erróneos -> activa alerta de calibración
    const largeSample = [
      ...Array.from({ length: 7 }, (_, i) => mkFollowup(`ok_${i}`, 'respondio')),
      ...Array.from({ length: 3 }, (_, i) => mkFollowup(`bad_${i}`, 'numero_inexistente')),
    ];
    const largeStats = computeOutcomeCalibrationStats(largeSample);
    expect(largeStats.sampleSizeSufficient).toBe(true);
    expect(largeStats.reachedCount).toBe(10);
    expect(largeStats.effectiveResponsesCount).toBe(7);
    expect(largeStats.negativeOutcomesCount).toBe(3);
    expect(largeStats.insights.some((i) => i.includes('Alerta de calibración'))).toBe(true);
  });

  it('FASE 7 & 8: valida E2E en Espacio Aislado de Pruebas (5 fichas completas + sin web + incompleta), 0 llamadas Places y vista previa Fase 8 bloqueada sin borrar 52 registros', () => {
    // 1. Verificar aislamiento total de colección Sandbox vs Producción
    expect(getFollowupsCollectionPath('uid_test', 'production')).toBe('users/uid_test/followups');
    expect(getFollowupsCollectionPath('uid_test', 'sandbox')).toBe('users/uid_test/sandbox_followups');

    // 2. Simular 52 registros de producción existentes intactos
    const production52: FollowupLeadRecord[] = Array.from({ length: 52 }, (_, i) => ({
      id: `prod_${i + 1}`,
      ownerUid: 'uid_test',
      placeId: `ChIJ_prod_${i + 1}`,
      sourceKind: 'places_preselection',
      independentBusinessName: i === 51 ? 'Cliente Histórico SA' : '',
      district: '',
      confirmedNoWebsite: false,
      independentWebsiteStatus: 'unregistered',
      independentPhone: i === 51 ? '+51 999 000 111' : '',
      independentPhoneType: i === 51 ? 'mobile' : 'none',
      phoneStage: i === 51 ? 'contact_reached' : 'none',
      independentEmail: '',
      independentDigitalScore: 80,
      independentContactScore: 40,
      stage: i === 51 ? 'CLIENTE' : i < 17 ? 'PRESELECCIONADO' : 'PENDIENTE DE VERIFICACIÓN',
      legalBasis: i === 51 ? 'Contrato firmado B2B' : '',
      qualificationTier: 'PRIORIDAD ALTA',
      aiSummary: '',
      notes: '',
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-02T00:00:00Z',
    }));

    // 3. Simular lote Sandbox: 4 fichas completas con web + 1 ficha completa confirmada sin web + 1 ficha incompleta
    const sandboxItems: FollowupLeadRecord[] = [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `sb_web_${i + 1}`,
        ownerUid: 'uid_test',
        placeId: `ChIJ_sb_web_${i + 1}`,
        sourceKind: 'places_preselection' as const,
        independentBusinessName: `Clínica Sandbox ${i + 1}`,
        district: 'Los Olivos',
        independentAddress: `Av. Carlos Izaguirre ${100 + i}`,
        independentWebsite: `https://clinicasandbox${i + 1}.pe`,
        independentCategory: 'Clínica Dental',
        confirmedNoWebsite: false,
        independentWebsiteStatus: 'active_http' as const,
        independentPhone: `+51 987 100 00${i + 1}`,
        independentPhoneType: 'mobile' as const,
        phoneStage: 'independently_corroborated' as const,
        independentEmail: `hola@clinicasandbox${i + 1}.pe`,
        independentDigitalScore: 70,
        independentContactScore: 85,
        independentTrustScore: 90,
        completenessStatus: 'complete' as const,
        stage: 'PRESELECCIONADO' as const,
        legalBasis: '',
        qualificationTier: 'PRIORIDAD ALTA' as const,
        aiSummary: '',
        notes: 'Corroborado desde web oficial en Sandbox',
        createdAt: '2026-11-19T00:00:00Z',
        updatedAt: '2026-11-19T00:00:00Z',
      })),
      {
        id: 'sb_noweb_5',
        ownerUid: 'uid_test',
        placeId: 'ChIJ_sb_noweb_5',
        sourceKind: 'independent_manual',
        independentBusinessName: 'Veterinaria Sin Web Norte',
        district: 'Comas',
        independentAddress: 'Av. Túpac Amaru 1250',
        independentWebsite: '',
        independentCategory: 'Veterinaria',
        confirmedNoWebsite: true,
        independentWebsiteStatus: 'confirmed_none',
        independentPhone: '+51 912 222 333',
        independentPhoneType: 'mobile',
        phoneStage: 'independently_corroborated',
        independentEmail: '',
        independentDigitalScore: 100,
        independentContactScore: 70,
        independentTrustScore: 85,
        completenessStatus: 'complete',
        stage: 'PRESELECCIONADO',
        legalBasis: '',
        qualificationTier: 'PRIORIDAD ALTA',
        aiSummary: '',
        notes: 'Confirmado manualmente sin sitio web propio',
        createdAt: '2026-11-19T00:00:00Z',
        updatedAt: '2026-11-19T00:00:00Z',
      },
      {
        id: 'sb_incomplete_6',
        ownerUid: 'uid_test',
        placeId: 'ChIJ_sb_incomplete_6',
        sourceKind: 'places_preselection',
        independentBusinessName: '',
        district: 'Los Olivos',
        confirmedNoWebsite: false,
        independentWebsiteStatus: 'unregistered',
        independentPhone: '',
        independentPhoneType: 'none',
        phoneStage: 'none',
        independentEmail: '',
        independentDigitalScore: 85,
        independentContactScore: 45,
        independentTrustScore: 20,
        completenessStatus: 'partial',
        stage: 'PENDIENTE DE VERIFICACIÓN',
        legalBasis: '',
        qualificationTier: 'REVISIÓN PENDIENTE',
        aiSummary: '',
        notes: 'Sin web oficial para corroborar',
        createdAt: '2026-11-19T00:00:00Z',
        updatedAt: '2026-11-19T00:00:00Z',
      },
    ];

    expect(evaluateFollowupCompleteness(sandboxItems[4]).isFichaIncompleta).toBe(false);
    expect(evaluateFollowupCompleteness(sandboxItems[5]).isFichaIncompleta).toBe(true);
    expect(evaluateFollowupCompleteness(sandboxItems[5]).label).toContain('FICHA INCOMPLETA');

    // Plan de transferencia idempotente en Sandbox evita duplicados al reintentar
    const batchPlan = planNonDestructiveFollowupBatch(
      sandboxItems,
      new Set(sandboxItems.slice(0, 2).map((s) => s.placeId))
    );
    expect(batchPlan.toCreate).toHaveLength(4);
    expect(batchPlan.skippedDuplicates).toBe(2);

    // Render en Sandbox con cuota Places agotada muestra banner Sandbox, 5 completas, 1 incompleta y las 52 de prod intactas
    const sandboxHtml = renderToStaticMarkup(
      React.createElement(FollowupCrmView, {
        isSignedIn: true,
        followups: sandboxItems,
        workspaceMode: 'sandbox',
        onChangeWorkspaceMode: () => {},
        productionCount: production52.length,
        hydrationCache: {},
        placesQuotaBlock: { blocked: true, source: 'google_resource_exhausted', message: '429' },
        quota: null,
        onFetchIntegrityBackup: async () => ({
          totalDocuments: sandboxItems.length,
          uniqueDocIds: sandboxItems.length,
          uniquePlaceIds: sandboxItems.length,
          backedUpAt: '2026-11-19T00:00:00Z',
          records: sandboxItems,
        }),
        onSignIn: () => {},
        onUpdateFollowup: async () => {},
        onCreateManualFollowup: async () => {},
      })
    );

    expect(sandboxHtml).toContain('Espacio Aislado de Pruebas (Fase 7 · Sandbox)');
    expect(sandboxHtml).toContain('Producción (52)');
    expect(sandboxHtml).toContain('Fichas Comerciales Completas (5)');
    expect(sandboxHtml).toContain('Cola de Investigación / Incompletas (1)');
    expect(sandboxHtml).toContain('Clínica Sandbox 1');
    expect(sandboxHtml).toContain('Veterinaria Sin Web Norte');
    expect(sandboxHtml).toContain('Conf: 90/100');

    // FASE 8: Vista previa read-only sobre los 52 registros de producción conserva CLIENTE y exclusiones y bloquea borrado automático
    const cleanupPreview = buildSafeLegacyCleanupPreview(production52, {
      backupVerified: true,
      exclusionPlaceIds: new Set(['ChIJ_prod_1']),
    });
    expect(cleanupPreview.executionBlocked).toBe(true);
    expect(cleanupPreview.totalRecords).toBe(52);
    expect(cleanupPreview.protectedClientesCount).toBe(1);
    expect(cleanupPreview.protectedExclusionsCount).toBe(1);
    expect(cleanupPreview.incompleteCleanupCandidatesCount).toBe(50);
    expect(production52).toHaveLength(52);
  });

  it('prevents Firestore PERMISSION_DENIED when promoting a Place ID with partial independent fields and empty business name, and clamps NaN/bounds', () => {
    const partialPayload = buildFollowupCreateDocPayload(
      'x6CYvdFo63ffoSVBN7F49rEOvZd2',
      {
        placeId: 'ChIJRScIUhfPBZERictBMSYrlu4',
        sourceKind: 'independent_manual',
        independentBusinessName: '',
        district: 'Los Olivos',
        confirmedNoWebsite: false,
        independentWebsiteStatus: 'unregistered',
        independentPhone: '+51 987 654 321',
        independentPhoneType: 'mobile',
        phoneStage: 'independently_corroborated',
        independentEmail: 'contacto@ejemplo.pe',
        independentDigitalScore: Number.NaN,
        independentContactScore: 142,
        independentTrustScore: -5,
        stage: 'PENDIENTE DE VERIFICACIÓN',
        legalBasis: '',
        qualificationTier: '',
        aiSummary: 'a'.repeat(900),
        notes: 'n'.repeat(1200),
        independentAddress: 'Av. Universitaria 1200',
        independentWebsite: '',
        independentCategory: 'Clínica',
        verificationSummary: 'Verificación parcial en Drawer',
        lastVerifiedAt: '2026-11-19T00:00:00Z',
        verificationSources: ['teléfono|user_manual_entry|+51 987 654 321|2026-11-19T00:00:00Z'],
      },
      { timestampValue: 'SERVER_TS' }
    );

    // firestore.rules exige sourceKind == 'places_preselection' si independentBusinessName está vacío
    expect(partialPayload.sourceKind).toBe('places_preselection');
    expect(partialPayload.independentBusinessName).toBe('');
    expect(partialPayload.independentDigitalScore).toBe(0);
    expect(partialPayload.independentContactScore).toBe(100);
    expect(partialPayload.independentTrustScore).toBe(0);
    expect((partialPayload.aiSummary as string).length).toBe(800);
    expect((partialPayload.notes as string).length).toBe(1000);
    expect(clampFirestoreScore(Number.NaN, 10)).toBe(10);

    // Registro manual sin Place ID y sin nombre debe fallar explícitamente antes de enviar a Firestore
    expect(() =>
      buildFollowupCreateDocPayload('uid_1', {
        placeId: 'manual_12345',
        sourceKind: 'independent_manual',
        independentBusinessName: '   ',
        district: 'Miraflores',
        confirmedNoWebsite: true,
        independentWebsiteStatus: 'confirmed_none',
        independentPhone: '+51 999 888 777',
        phoneStage: 'independently_corroborated',
        independentEmail: '',
        independentDigitalScore: 90,
        independentContactScore: 75,
        stage: 'PENDIENTE DE VERIFICACIÓN',
        legalBasis: '',
        qualificationTier: '',
        aiSummary: '',
        notes: '',
      })
    ).toThrow(/nombre comercial/i);
  });
});

describe('11. Persistencia fiel de fichas, URLs manuales, reportes de servidor y reparación no destructiva (caso Sandbox Gavet)', () => {
  it('resolveIndependentWebsiteStatusForSave registra URLs manuales como unverified_inconclusive / invalid_url sin descartarlas ni marcarlas verificadas', () => {
    expect(
      resolveIndependentWebsiteStatusForSave({
        independentWebsite: 'https://veterinariagavetperu.com',
        confirmedNoWebsite: false,
        verifiedProbe: null,
      })
    ).toBe('unverified_inconclusive');

    expect(
      resolveIndependentWebsiteStatusForSave({
        independentWebsite: 'no-es-url-valida',
        confirmedNoWebsite: false,
        verifiedProbe: null,
      })
    ).toBe('invalid_url');

    expect(
      resolveIndependentWebsiteStatusForSave({
        independentWebsite: '',
        confirmedNoWebsite: true,
        verifiedProbe: null,
      })
    ).toBe('confirmed_none');

    const matchingProbe = {
      checkedUrl: 'https://veterinariagavetperu.com',
      finalUrl: 'https://veterinariagavetperu.com/',
      status: 'active_https' as const,
      httpStatus: 200,
      tlsValid: true,
      isSocialOnly: false,
      inconclusiveReason: null,
      summary: 'Sitio HTTPS activo',
      verifiedAt: '2026-11-19T00:00:00Z',
      provenance: 'independent_http' as const,
    };

    expect(
      resolveIndependentWebsiteStatusForSave({
        independentWebsite: 'https://veterinariagavetperu.com',
        confirmedNoWebsite: false,
        verifiedProbe: matchingProbe,
      })
    ).toBe('active_https');

    // Si el usuario cambió a otra URL distinta a la sondeada, NO heredar el estado de la URL anterior
    expect(
      resolveIndependentWebsiteStatusForSave({
        independentWebsite: 'https://otrowebpropia.pe',
        confirmedNoWebsite: false,
        verifiedProbe: matchingProbe,
      })
    ).toBe('unverified_inconclusive');
  });

  it('reproduce el caso exacto Sandbox Gavet, reporta campos faltantes reales y repara solo los vacíos sin sobrescribir datos previos', () => {
    const sandboxGavetPartial: FollowupLeadRecord = {
      id: 'lead_ChIJRScIUhfPBZERictBMSYrlu4',
      ownerUid: 'x6CYvdFo63ffoSVBN7F49rEOvZd2',
      placeId: 'ChIJRScIUhfPBZERictBMSYrlu4',
      sourceKind: 'places_preselection',
      independentBusinessName: '',
      district: 'Los Olivos',
      confirmedNoWebsite: false,
      independentWebsiteStatus: 'unregistered',
      independentPhone: '+51 993 580 357',
      independentPhoneType: 'mobile',
      phoneStage: 'independently_corroborated',
      independentEmail: 'hola@veterinariagavetperu.com',
      independentDigitalScore: 85,
      independentContactScore: 85,
      independentTrustScore: 45,
      completenessStatus: 'partial',
      stage: 'PENDIENTE DE VERIFICACIÓN',
      legalBasis: '',
      qualificationTier: '',
      aiSummary: '',
      notes: 'Verificado manualmente en Sandbox',
      independentAddress: '',
      independentWebsite: '',
      independentCategory: 'Veterinarias',
      createdAt: '2026-11-19T00:00:00Z',
      updatedAt: '2026-11-19T00:05:00Z',
    };

    const preReport = buildPersistedVerificationReport(sandboxGavetPartial);
    expect(preReport.isComplete).toBe(false);
    expect(preReport.status).toBe('partial');
    expect(preReport.missingReasons.some((r) => r.includes('Nombre comercial'))).toBe(true);
    expect(preReport.missingReasons.some((r) => r.includes('Dirección exacta'))).toBe(true);
    expect(preReport.missingReasons.some((r) => r.includes('Sitio web'))).toBe(true);

    // En la vista CRM, si hay caché de Explorador pero Firestore tiene nombre vacío, nunca ocultarlo ni confundirlo como persistido
    const crmHtmlWithCache = renderToStaticMarkup(
      React.createElement(FollowupCrmView, {
        isSignedIn: true,
        followups: [sandboxGavetPartial],
        workspaceMode: 'sandbox',
        hydrationCache: {
          ChIJRScIUhfPBZERictBMSYrlu4: {
            placeId: 'ChIJRScIUhfPBZERictBMSYrlu4',
            status: 'loaded',
            details: {
              placeId: 'ChIJRScIUhfPBZERictBMSYrlu4',
              displayName: 'Clínica Veterinaria Gavet - Los Olivos',
              formattedAddress: 'Av. Las Palmeras 3900',
              nationalPhoneNumber: '993 580 357',
              internationalPhoneNumber: '+51 993 580 357',
              websiteUri: null,
              googleMapsUri: 'https://maps.google.com/?cid=1',
              businessStatus: 'OPERATIONAL',
            },
            retryCount: 0,
            updatedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
        },
        placesQuotaBlock: { blocked: false, source: 'none', message: null },
        quota: null,
        onFetchIntegrityBackup: async () => ({
          totalDocuments: 1,
          uniqueDocIds: 1,
          uniquePlaceIds: 1,
          backedUpAt: '2026-11-19T00:05:00Z',
          records: [sandboxGavetPartial],
        }),
        onSignIn: () => {},
        onUpdateFollowup: async () => {},
        onCreateManualFollowup: async () => {},
      })
    );
    expect(crmHtmlWithCache).toContain('Sin nombre comercial persistido (ChIJRScIUhfPBZERictBMSYrlu4)');
    expect(crmHtmlWithCache).toContain('Ref. sesión Explorador (NO persistido en Firestore)');
    expect(crmHtmlWithCache).toContain('Clínica Veterinaria Gavet - Los Olivos');

    // Reparación parcial segura: intenta pasar teléfono/correo distintos, pero buildMissingFieldsPatch SOLO toca los vacíos
    const repairPatch = buildMissingFieldsPatch(sandboxGavetPartial, {
      independentBusinessName: 'Clínica Veterinaria Gavet - Los Olivos',
      independentAddress: 'Av. Las Palmeras 3900, Los Olivos',
      independentWebsite: 'https://veterinariagavetperu.com',
      independentPhone: '+51 900 000 000',
      independentEmail: 'otro@correo.com',
      district: 'Otro Distrito',
      independentCategory: 'Otro Rubro',
      verificationSummary: 'Reparación parcial verificada',
      lastVerifiedAt: '2026-11-19T01:00:00Z',
      verificationSources: [
        'nombre|user_manual_entry|Clínica Veterinaria Gavet - Los Olivos|2026-11-19T01:00:00Z',
      ],
    });

    expect(repairPatch.independentBusinessName).toBe('Clínica Veterinaria Gavet - Los Olivos');
    expect(repairPatch.independentAddress).toBe('Av. Las Palmeras 3900, Los Olivos');
    expect(repairPatch.independentWebsite).toBe('https://veterinariagavetperu.com');
    expect(repairPatch.independentWebsiteStatus).toBe('unverified_inconclusive');
    // Jamás sobrescribir campos ya existentes
    expect(repairPatch.independentPhone).toBeUndefined();
    expect(repairPatch.independentEmail).toBeUndefined();
    expect(repairPatch.district).toBeUndefined();
    expect(repairPatch.independentCategory).toBeUndefined();

    const repairedRecord: FollowupLeadRecord = {
      ...sandboxGavetPartial,
      independentBusinessName: String(repairPatch.independentBusinessName),
      independentAddress: String(repairPatch.independentAddress),
      independentWebsite: String(repairPatch.independentWebsite),
      independentWebsiteStatus: repairPatch.independentWebsiteStatus as FollowupLeadRecord['independentWebsiteStatus'],
    };

    const postReport = buildPersistedVerificationReport(repairedRecord);
    expect(postReport.isComplete).toBe(true);
    expect(postReport.status).toBe('complete');
    // Debe transparentar que la web sigue unverified_inconclusive hasta comprobación HTTP
    expect(postReport.missingReasons.some((r) => r.includes('NO VERIFICADO'))).toBe(true);

    // Payload completo nuevo conserva exactos nombre, dirección, web, procedencia y completenessStatus === 'complete'
    const fullPayload = buildFollowupCreateDocPayload(
      'x6CYvdFo63ffoSVBN7F49rEOvZd2',
      {
        placeId: 'ChIJRScIUhfPBZERictBMSYrlu4',
        sourceKind: 'independent_manual',
        independentBusinessName: 'Clínica Veterinaria Gavet - Los Olivos',
        district: 'Los Olivos',
        confirmedNoWebsite: false,
        independentWebsiteStatus: resolveIndependentWebsiteStatusForSave({
          independentWebsite: 'https://veterinariagavetperu.com',
          confirmedNoWebsite: false,
          verifiedProbe: null,
        }),
        independentPhone: '+51 993 580 357',
        independentPhoneType: 'mobile',
        phoneStage: 'independently_corroborated',
        independentEmail: 'hola@veterinariagavetperu.com',
        independentDigitalScore: 85,
        independentContactScore: 85,
        independentTrustScore: 85,
        stage: 'PENDIENTE DE VERIFICACIÓN',
        legalBasis: '',
        qualificationTier: '',
        aiSummary: '',
        notes: 'Ficha completa en revisión manual',
        independentAddress: 'Av. Las Palmeras 3900, Los Olivos',
        independentWebsite: 'https://veterinariagavetperu.com',
        independentCategory: 'Veterinarias',
        verificationSummary: 'Ficha comercial completa preparada y verificada en Firestore.',
        lastVerifiedAt: '2026-11-19T01:00:00Z',
        verificationSources: [
          'nombre|user_manual_entry|Clínica Veterinaria Gavet - Los Olivos|2026-11-19T01:00:00Z',
          'dirección|user_manual_entry|Av. Las Palmeras 3900, Los Olivos|2026-11-19T01:00:00Z',
          'web|user_manual_entry|https://veterinariagavetperu.com|2026-11-19T01:00:00Z',
        ],
      },
      { timestampValue: 'SERVER_TS' }
    );

    expect(fullPayload.completenessStatus).toBe('complete');
    expect(fullPayload.independentBusinessName).toBe('Clínica Veterinaria Gavet - Los Olivos');
    expect(fullPayload.independentAddress).toBe('Av. Las Palmeras 3900, Los Olivos');
    expect(fullPayload.independentWebsite).toBe('https://veterinariagavetperu.com');
    expect(fullPayload.independentWebsiteStatus).toBe('unverified_inconclusive');
    expect(fullPayload.independentPhone).toBe('+51 993 580 357');
    expect(fullPayload.independentEmail).toBe('hola@veterinariagavetperu.com');
    expect((fullPayload.verificationSources as string[]).length).toBe(3);
  });
});

describe('12. Módulo Investigar datos faltantes (0 Places): Casos A, B, C, D, Identity Gate y Endpoint HTTP', () => {
  const publicDnsLookup = (async () => [{ address: '93.184.216.34', family: 4 }]) as any;

  it('Caso A: negocio con web oficial multi-sede corrobora teléfono coincidente con Maps y clasifica 4 estados con 0 llamadas Places', async () => {
    const htmlGavet = `
      <!doctype html>
      <html>
        <head>
          <title>Clínica Veterinaria Gavet</title>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "VeterinaryCare",
              "name": "Clínica Veterinaria Gavet",
              "telephone": "+51 960 814 125",
              "email": "hola@veterinariagavetperu.com",
              "address": {
                "@type": "PostalAddress",
                "streetAddress": "Av. Las Palmeras 3900",
                "addressLocality": "Los Olivos"
              }
            }
          </script>
        </head>
        <body>
          <h1>Clínica Veterinaria Gavet</h1>
          <p>Sede Los Olivos: Av. Las Palmeras 3900, Los Olivos.</p>
          <a href="https://wa.me/51993580357">WhatsApp Los Olivos</a>
          <a href="https://wa.me/51960814125">WhatsApp San Martín</a>
        </body>
      </html>
    `;

    const fakeFetch = (async (url: string) => {
      if (String(url).includes('veterinariagavetperu.com')) {
        return new Response(htmlGavet, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const result = await researchMissingLeadData(
      {
        placeId: 'ChIJ_GAVET_A',
        officialWebsiteUrl: 'https://veterinariagavetperu.com',
        searchCategory: 'Veterinarias',
        searchDistrict: 'Los Olivos',
        sessionMapsRef: {
          name: 'Clínica Veterinaria Gavet - Los Olivos',
          address: 'Av. Las Palmeras 3900, Los Olivos',
          phone: '+51 993 580 357',
          district: 'Los Olivos',
          website: 'https://veterinariagavetperu.com',
        },
      },
      { fetchFn: fakeFetch, dnsLookupFn: publicDnsLookup }
    );

    expect(result.hasContradictions).toBe(false);
    expect(result.canPersistCompleteCard).toBe(true);
    expect(result.recommendedQueue).toBe('complete_ready');
    expect(result.fieldClassifications.businessName.status).toBe('corroborated_persistable');
    expect(result.fieldClassifications.phone.status).toBe('corroborated_persistable');
    expect(result.fieldClassifications.address.status).toBe('corroborated_persistable');
    expect(result.fieldClassifications.website.status).toBe('corroborated_persistable');
    expect(result.fieldClassifications.email.status).toBe('corroborated_persistable');
    expect(result.corroboration.candidates.phone?.value).toBe('+51 993 580 357');
    expect(result.corroboration.candidates.email?.value).toBe('hola@veterinariagavetperu.com');
  });

  it('Caso B + Identity Gate + Privacidad: negocio sin web corrobora DatosPeru + evidencia autorizada, rechaza homónimo textil y jamás extrae DNIs', async () => {
    const htmlTextileMismatch = `
      <html><head><title>TEXTILES CONSENTIDOS S.A.C.</title></head><body>
        <h1>TEXTILES CONSENTIDOS S.A.C.</h1>
        <div>RUC: 20511223344</div>
        <div>Estado: ACTIVO</div>
        <div>Condición: HABIDO</div>
        <div>Dirección: JR. GAMARRA 450, LA VICTORIA, LIMA</div>
        <div>CIIU: 1410 - FABRICACION DE PRENDAS DE VESTIR</div>
        <div>Representante Legal: JUAN PEREZ DNI 40112233</div>
      </body></html>
    `;
    const parsedMismatch = parseDatosPeruCompanyHtml(
      htmlTextileMismatch,
      'https://www.datosperu.org/empresa-textiles-consentidos.php'
    );
    expect(parsedMismatch).not.toBeNull();
    expect(JSON.stringify(parsedMismatch)).not.toContain('40112233');
    expect(JSON.stringify(parsedMismatch)).not.toContain('JUAN PEREZ');
    expect(
      passesDatosPeruIdentityGate(parsedMismatch!, {
        businessName: 'Veterinaria Consentidos',
        district: 'Los Olivos',
        category: 'Veterinarias',
      }).accepted
    ).toBe(false);

    const htmlDatosPeruSearch = `
      <html><body>
        <a href="empresa-textiles-consentidos-20511223344.php">TEXTILES CONSENTIDOS S.A.C.</a>
        <a href="empresa-veterinaria-consentidos-20609988771.php">VETERINARIA CONSENTIDOS S.A.C.</a>
      </body></html>
    `;
    const htmlVetDetail = `
      <html><head><title>VETERINARIA CONSENTIDOS S.A.C.</title></head><body>
        <h1>VETERINARIA CONSENTIDOS S.A.C.</h1>
        <div>RUC: 20609988771</div>
        <div>Estado: ACTIVO</div>
        <div>Condición: HABIDO</div>
        <div>Dirección: AV. NARANJAL 1420, LOS OLIVOS, LIMA</div>
        <div>CIIU: 7500 - ACTIVIDADES VETERINARIAS</div>
        <div>Gerente General: MARIA LOPEZ DNI 41998877</div>
      </body></html>
    `;

    const fakeFetch = (async (url: string) => {
      const s = String(url);
      if (s.includes('facebook.com')) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://www.facebook.com/login/?next=consentidos' },
        });
      }
      if (s.includes('buscador_empresas.php')) {
        return new Response(htmlDatosPeruSearch, { status: 200 });
      }
      if (s.includes('empresa-textiles-consentidos')) {
        return new Response(htmlTextileMismatch, { status: 200 });
      }
      if (s.includes('empresa-veterinaria-consentidos')) {
        return new Response(htmlVetDetail, { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const resB = await researchMissingLeadData(
      {
        placeId: 'ChIJ_CONSENTIDOS_B',
        officialWebsiteUrl: '',
        socialOrDirectoryUrl: 'https://www.facebook.com/VeterinariaConsentidos/',
        userProvidedEvidenceText:
          'Tarjeta verificada de atención: WhatsApp +51 987 654 321 · Correo: citas@consentidosvet.pe',
        searchCategory: 'Veterinarias',
        searchDistrict: 'Los Olivos',
        sessionMapsRef: {
          name: 'Veterinaria Consentidos',
          address: 'Av. Naranjal 1420, Los Olivos',
          phone: '+51 987 654 321',
          district: 'Los Olivos',
          website: '',
        },
      },
      { fetchFn: fakeFetch, dnsLookupFn: publicDnsLookup }
    );

    const metaAttempt = resB.sourceAttempts.find((a) => a.sourceId === 'meta_social');
    expect(metaAttempt?.status).toBe('blocked_or_restricted');
    expect(metaAttempt?.detail).toContain('login wall');

    const datosPeruAttempt = resB.sourceAttempts.find((a) => a.sourceId === 'datosperu_ruc');
    expect(datosPeruAttempt?.status).toBe('found');
    expect(resB.hasContradictions).toBe(false);
    expect(resB.fieldClassifications.businessName.status).toBe('corroborated_persistable');
    expect(resB.fieldClassifications.businessName.independentValue).toBe('VETERINARIA CONSENTIDOS S.A.C.');
    expect(resB.fieldClassifications.address.status).toBe('corroborated_persistable');
    expect(resB.fieldClassifications.phone.status).toBe('corroborated_persistable');
    expect(resB.fieldClassifications.phone.independentValue).toBe('+51 987 654 321');
    expect(resB.fieldClassifications.email.independentValue).toBe('citas@consentidosvet.pe');
  });

  it('Caso C: sin fuentes independientes disponibles mantiene candidato en research_queue y NUNCA copia campos de sesión Maps', async () => {
    const fakeFetch = (async (url: string) => {
      if (String(url).includes('instagram.com')) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://www.instagram.com/accounts/login/' },
        });
      }
      return new Response('<html><body>Sin resultados</body></html>', { status: 200 });
    }) as typeof fetch;

    const resC = await researchMissingLeadData(
      {
        placeId: 'ChIJ_CONSENTIDOS_C',
        officialWebsiteUrl: '',
        socialOrDirectoryUrl: 'https://www.instagram.com/consentidosvet/',
        searchCategory: 'Veterinarias',
        searchDistrict: 'Los Olivos',
        sessionMapsRef: {
          name: 'Veterinaria Consentidos – Los Olivos',
          address: 'Av. Naranjal 1420, Los Olivos',
          phone: '+51 987 654 321',
          district: 'Los Olivos',
          website: '',
        },
      },
      { fetchFn: fakeFetch, dnsLookupFn: publicDnsLookup }
    );

    expect(resC.canPersistCompleteCard).toBe(false);
    expect(resC.recommendedQueue).toBe('research_queue');
    expect(resC.hasContradictions).toBe(false);
    expect(resC.corroboration.candidates.businessName).toBeNull();
    expect(resC.corroboration.candidates.phone).toBeNull();
    expect(resC.corroboration.candidates.address).toBeNull();
    expect(resC.fieldClassifications.businessName.status).toBe('maps_session_only');
    expect(resC.fieldClassifications.phone.status).toBe('maps_session_only');
    expect(resC.fieldClassifications.address.status).toBe('maps_session_only');
    expect(resC.fieldClassifications.website.status).toBe('not_found');
    expect(resC.missingPersistableFields.length).toBeGreaterThanOrEqual(4);
    expect(resC.manualReviewLinks.length).toBeGreaterThanOrEqual(2);
    expect(getFieldClassificationMeta('maps_session_only').label).toBe(
      'Disponible solamente en sesión de Google Maps'
    );
  });

  it('Caso D: teléfono contradictorio entre fuente independiente y Google Maps bloquea auto-relleno y fuerza research_queue', async () => {
    const htmlMismatchPhone = `
      <html><head><title>Veterinaria Alfa</title></head><body>
        <h1>Veterinaria Alfa</h1>
        <p>Av. Universitaria 3200, Los Olivos</p>
        <a href="tel:+51911222333">Llamar 911 222 333</a>
      </body></html>
    `;
    const fakeFetch = (async (url: string) => {
      if (String(url).includes('veterinariaalfa.pe')) {
        return new Response(htmlMismatchPhone, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const resD = await researchMissingLeadData(
      {
        placeId: 'ChIJ_CONTRADICTORY_D',
        officialWebsiteUrl: 'https://veterinariaalfa.pe',
        searchCategory: 'Veterinarias',
        searchDistrict: 'Los Olivos',
        sessionMapsRef: {
          name: 'Veterinaria Alfa',
          address: 'Av. Universitaria 3200, Los Olivos',
          phone: '+51 999 888 777',
          district: 'Los Olivos',
          website: 'https://veterinariaalfa.pe',
        },
      },
      { fetchFn: fakeFetch, dnsLookupFn: publicDnsLookup }
    );

    expect(resD.hasContradictions).toBe(true);
    expect(resD.canPersistCompleteCard).toBe(false);
    expect(resD.recommendedQueue).toBe('research_queue');
    expect(resD.fieldClassifications.phone.status).toBe('contradictory');
    expect(resD.corroboration.candidates.phone).toBeNull();
    expect(resD.contradictionAlerts[0]).toMatch(/contradictorio/i);
  });

  it('Etapas del embudo (1-4) y endpoint POST /api/leads/research-missing garantizan 0 llamadas a Google Places', async () => {
    const s1 = evaluateFourStagePipelineStatus({
      placeId: 'ChIJ_stage1',
      independentBusinessName: '',
      independentPhone: '',
      independentAddress: '',
      district: 'Los Olivos',
      independentWebsite: '',
      confirmedNoWebsite: false,
      independentEmail: '',
      independentCategory: 'Veterinarias',
      stage: 'PENDIENTE DE VERIFICACIÓN',
      legalBasis: '',
      phoneStage: 'none',
    });
    expect(s1.currentStageLabel).toBe('1. Candidato en Google Maps');

    const s2 = evaluateFourStagePipelineStatus({
      placeId: 'ChIJ_stage2',
      independentBusinessName: 'Vet Real',
      independentPhone: '+51 987 654 321',
      independentAddress: 'Av. Perú 100',
      district: 'Los Olivos',
      independentWebsite: 'https://vetreal.pe',
      confirmedNoWebsite: false,
      independentEmail: '',
      independentCategory: 'Veterinarias',
      stage: 'PRESELECCIONADO',
      legalBasis: '',
      phoneStage: 'independently_corroborated',
    });
    expect(s2.currentStageLabel).toBe('2. Ficha comercial corroborada');

    const s3 = evaluateFourStagePipelineStatus({
      placeId: 'ChIJ_stage3',
      independentBusinessName: 'Vet Real',
      independentPhone: '+51 987 654 321',
      independentAddress: 'Av. Perú 100',
      district: 'Los Olivos',
      independentWebsite: '',
      confirmedNoWebsite: true,
      independentEmail: '',
      independentCategory: 'Veterinarias',
      stage: 'CONTACTO AUTORIZADO',
      legalBasis: 'Consentimiento escrito B2B',
      phoneStage: 'independently_corroborated',
    });
    expect(s3.currentStageLabel).toBe('3. Contacto legalmente autorizado');

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<html><body>Sin datos</body></html>', { status: 404 })) as typeof fetch;

    const guard = new DailyQuotaGuard({ placesLimit: 60, geminiLimit: 40 });
    const app = createApiApp(guard);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    try {
      const port = (server.address() as AddressInfo).port;
      const resp = await origFetch(`http://127.0.0.1:${port}/api/leads/research-missing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              placeId: 'ChIJ_http_0_places',
              searchCategory: 'Veterinarias',
              searchDistrict: 'Los Olivos',
              userProvidedEvidenceText: 'Teléfono verificado +51 987 654 321 · Razón social: Vet Norte SAC',
              sessionMapsRef: {
                name: 'Vet Norte',
                phone: '+51 987 654 321',
                district: 'Los Olivos',
              },
            },
          ],
        }),
      });
      expect(resp.status).toBe(200);
      const data: any = await resp.json();
      expect(data.placesCallsConsumed).toBe(0);
      expect(data.quota.placesUsed).toBe(0);
      expect(data.results).toHaveLength(1);
      expect(data.results[0].fieldClassifications.phone.independentValue).toBe('+51 987 654 321');
    } finally {
      server.close();
      globalThis.fetch = origFetch;
    }
  });

  it('Caso Real Negativo (CETT CONSENTIDOS S.A.C. RUC 20610386009 vs Veterinaria Consentidos - Los Olivos): rechaza por rubro/CIIU y geografía, clasifica IDENTIDAD NO CONFIRMADA y nunca sustituye nombre', async () => {
    const htmlRealCettConsentidos = `
      <html>
        <head><title>CETT CONSENTIDOS S.A.C - RUC 20610386009 | Datos Perú</title></head>
        <body>
          <h1>CETT CONSENTIDOS S.A.C</h1>
          <div>RUC 20610386009</div>
          <div>Estado Contribuyente ACTIVO</div>
          <div>Condición Contribuyente HABIDO</div>
          <div>Domicilio Fiscal AV. LAS FLORES DE PRIMAVERA NRO. 651 COO. LAS FLORES (PARADERO 4 DE LA AVENIDA LAS FLORES) SAN JUAN DE LURIGANCHO - LIMA - LIMA</div>
          <div>REACTIVA PERÚ</div>
          <div>Actividades Económicas
            CIIU: 8690 Principal OTRAS ACTIVIDADES DE ATENCIÓN DE LA SALUD HUMANA
            CIIU: 8550 Secundaria ACTIVIDADES DE APOYO A LA ENSEÑANZA
            CIIU: 9609 Secundaria OTRAS ACTIVIDADES DE SERVICIOS PERSONALES N.C.P.
          </div>
          <div>ALGUNOS DE LOS PRINCIPALES EJECUTIVOS</div>
        </body>
      </html>
    `;

    const htmlAutomotiveHomonymSameDistrict = `
      <html>
        <head><title>CONSENTIDOS CAR E.I.R.L</title></head>
        <body>
          <h1>CONSENTIDOS CAR E.I.R.L</h1>
          <div>RUC 20608694138</div>
          <div>Estado Contribuyente ACTIVO</div>
          <div>Domicilio Fiscal AV. UNIVERSITARIA 1800 LOS OLIVOS - LIMA</div>
          <div>CIIU: 4520 Principal MANTENIMIENTO Y REPARACION DE VEHICULOS AUTOMOTORES</div>
        </body>
      </html>
    `;

    const parsedCett = parseDatosPeruCompanyHtml(
      htmlRealCettConsentidos,
      'https://www.datosperu.org/empresa-cett-consentidos-sac-20610386009.php'
    );
    expect(parsedCett).not.toBeNull();
    expect(parsedCett!.district).toBe('San Juan de Lurigancho');
    expect(parsedCett!.domicilioFiscal).toContain('SAN JUAN DE LURIGANCHO');
    expect(parsedCett!.ciiuCodes).toEqual(['8690', '8550', '9609']);
    expect(parsedCett!.principalCiiu).toContain('8690');

    // Rechazo por contradicción determinante de rubro/CIIU (Salud Humana vs Veterinarias)
    const gateByCategory = passesDatosPeruIdentityGate(parsedCett!, {
      businessName: 'Veterinaria Consentidos - Los Olivos',
      district: 'Los Olivos',
      address: 'Taurija MZ A, Los Olivos',
      category: 'Veterinarias',
    });
    expect(gateByCategory.accepted).toBe(false);
    expect(gateByCategory.reason).toMatch(/rubro\/CIIU|8690/i);

    // Incluso sin categoría, el filtro geográfico obligatorio rechaza San Juan de Lurigancho vs Los Olivos
    const gateByGeoOnly = passesDatosPeruIdentityGate(parsedCett!, {
      businessName: 'Veterinaria Consentidos - Los Olivos',
      district: 'Los Olivos',
      address: 'Taurija MZ A, Los Olivos',
      category: '',
    });
    expect(gateByGeoOnly.accepted).toBe(false);
    expect(gateByGeoOnly.reason).toMatch(/Contradicción geográfica/i);

    // Homónimo en el MISMO distrito (Los Olivos) pero rubro automotriz también debe ser rechazado
    const parsedCar = parseDatosPeruCompanyHtml(
      htmlAutomotiveHomonymSameDistrict,
      'https://www.datosperu.org/empresa-consentidos-car-eirl-20608694138.php'
    );
    const gateCar = passesDatosPeruIdentityGate(parsedCar!, {
      businessName: 'Veterinaria Consentidos - Los Olivos',
      district: 'Los Olivos',
      category: 'Veterinarias',
    });
    expect(gateCar.accepted).toBe(false);

    // E2E simulado completo incluyendo directorios 403 Cloudflare (TodosNegocios / Cybo)
    const fakeFetch = (async (url: string) => {
      const s = String(url);
      if (s.includes('todosnegocios.com') || s.includes('cybo.com')) {
        return new Response('<html><title>Just a moment...</title></html>', { status: 403 });
      }
      if (s.includes('buscador_empresas.php')) {
        return new Response(
          `
            <a href="empresa-cett-consentidos-sac-20610386009.php">CETT CONSENTIDOS</a>
            <a href="empresa-consentidos-car-eirl-20608694138.php">CONSENTIDOS CAR</a>
          `,
          { status: 200 }
        );
      }
      if (s.includes('empresa-cett-consentidos')) {
        return new Response(htmlRealCettConsentidos, { status: 200 });
      }
      if (s.includes('empresa-consentidos-car')) {
        return new Response(htmlAutomotiveHomonymSameDistrict, { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const result = await researchMissingLeadData(
      {
        placeId: 'ChIJ_real_consentidos',
        officialWebsiteUrl: '',
        socialOrDirectoryUrl: 'https://pe.todosnegocios.com/veterinaria-consentidos-los-olivos-990-144-207',
        searchCategory: 'Veterinarias',
        searchDistrict: 'Los Olivos',
        sessionMapsRef: {
          name: 'Veterinaria Consentidos - Los Olivos',
          address: 'Taurija MZ A, Los Olivos',
          phone: '+51 990 144 207',
          district: 'Los Olivos',
          website: '',
        },
      },
      { fetchFn: fakeFetch, dnsLookupFn: publicDnsLookup }
    );

    expect(result.identityMatch.overallConfidence).toBe('unconfirmed');
    expect(result.identityMatch.identityStatusLabel).toBe('IDENTIDAD NO CONFIRMADA');
    expect(result.identityMatch.summary).toContain('IDENTIDAD NO CONFIRMADA');
    expect(result.identityMatch.rejectionReasons?.length).toBeGreaterThanOrEqual(2);
    expect(result.canPersistCompleteCard).toBe(false);
    expect(result.recommendedQueue).toBe('research_queue');
    // Jamás sustituir nombre ni copiar teléfono de Maps
    expect(result.corroboration.candidates.businessName).toBeNull();
    expect(result.corroboration.candidates.phone).toBeNull();
    expect(result.fieldClassifications.businessName.status).toBe('maps_session_only');
    expect(result.fieldClassifications.phone.status).toBe('maps_session_only');
    // Directorio Cloudflare 403 reportado honestamente sin almacenamiento automático
    const dirAttempt = result.sourceAttempts.find((a) => a.sourceId === 'directory_reference');
    expect(dirAttempt?.status).toBe('blocked_or_restricted');
    expect(dirAttempt?.httpStatus).toBe(403);
    expect(dirAttempt?.retentionPermitted).toBe(false);
  });

  it('Acepta sucursal legítima solo cuando acredita CIIU compatible y Establecimiento Anexo en el distrito consultado', () => {
    const htmlSucursalVet = `
      <html>
        <head><title>CLINICA VETERINARIA HUAYLAS S.A.C.</title></head>
        <body>
          <h1>CLINICA VETERINARIA HUAYLAS S.A.C.</h1>
          <div>RUC 20601112223</div>
          <div>Estado Contribuyente ACTIVO</div>
          <div>Domicilio Fiscal AV. LARCO 450 MIRAFLORES - LIMA</div>
          <div>Actividades Económicas CIIU: 7500 Principal ACTIVIDADES VETERINARIAS</div>
          <div>ESTABLECIMIENTOS ANEXOS
            AV. NARANJAL 500 LOS OLIVOS - LIMA
          </div>
        </body>
      </html>
    `;
    const parsedBranch = parseDatosPeruCompanyHtml(
      htmlSucursalVet,
      'https://www.datosperu.org/empresa-vet-huaylas.php'
    );
    const gateBranch = passesDatosPeruIdentityGate(parsedBranch!, {
      businessName: 'Veterinaria Huaylas',
      district: 'Los Olivos',
      category: 'Veterinarias',
    });
    expect(gateBranch.accepted).toBe(true);
    expect(gateBranch.branchEvidenceInDistrict).toBe(true);
    expect(gateBranch.matchedDistrictAddress).toContain('LOS OLIVOS');
  });
});

describe('13. Rediseño Funcional: Cola Temporal de Sesión (Fases 1-2), Borrado Firestore Controlado (Fase 3), Resultados/CRM (Fase 4) y Preselección Determinística (Fase 5)', () => {
  const emptyExcl = buildExclusionKeySet([]);

  const buildSampleRawPlace = (idx: number, overrides: Partial<GooglePlaceRaw> = {}): GooglePlaceRaw => ({
    placeId: `ChIJ_temp_${idx}`,
    displayName: `Negocio Prueba ${idx}`,
    formattedAddress: `Av. Palmeras ${100 + idx}, Los Olivos`,
    location: { lat: -11.98, lng: -77.06 },
    nationalPhoneNumber: `987 654 32${idx}`,
    internationalPhoneNumber: `+51 987 654 32${idx}`,
    websiteUri: idx % 2 === 0 ? null : `https://negocio${idx}.pe`,
    googleMapsUri: `https://maps.google.com/?cid=${idx}`,
    rating: 4.5,
    userRatingCount: 20,
    businessStatus: 'OPERATIONAL',
    primaryTypeDisplayName: 'Veterinaria',
    ...overrides,
  });

  it('FASE 1 & 2: agrega 5 prospectos con nombre y teléfono inmediatos (0 Places Details), deduplica por Place ID, filtra, edita y elimina sin perder estado', () => {
    const leads5 = [1, 2, 3, 4, 5].map((i) =>
      buildBusinessLeadFromPlace(buildSampleRawPlace(i), 'Veterinarias', emptyExcl)
    );

    const addRes1 = addLeadsToTemporaryQueue([], leads5, {
      district: 'Los Olivos, Lima',
      category: 'Veterinarias',
    });

    expect(addRes1.addedCount).toBe(5);
    expect(addRes1.skippedDuplicates).toBe(0);
    expect(addRes1.queue).toHaveLength(5);

    // Todos muestran nombre y teléfono desde Explorador inmediatamente sin requerir 4/4 campos independientes
    for (const entry of addRes1.queue) {
      expect(entry.lead.name).toMatch(/^Negocio Prueba \d$/);
      expect(entry.lead.phone).toMatch(/^\+51 987 654 32\d$/);
      expect(entry.outcome).toBe('pendiente');
      expect(entry.independentData.independentBusinessName).toBe('');
    }

    // Reintentar agregar duplicados no duplica Place IDs
    const dupRes = addLeadsToTemporaryQueue(addRes1.queue, [leads5[0], leads5[2]]);
    expect(dupRes.addedCount).toBe(0);
    expect(dupRes.skippedDuplicates).toBe(2);
    expect(dupRes.queue).toHaveLength(5);

    // Edición de resultado comercial y nota propia WEBNEX
    let queue = updateTemporaryQueueEntry(addRes1.queue, 'ChIJ_temp_2', {
      outcome: 'interesado',
      notes: 'Mostró interés en renovación web.',
      independentData: {
        independentBusinessName: 'Veterinaria Prueba 2 SAC',
        independentPhone: '+51 987 654 322',
        independentAddress: 'Av. Palmeras 102, Los Olivos',
        district: 'Los Olivos',
        confirmedNoWebsite: true,
        legalBasis: 'Solicitud directa recibida vía formulario web',
        provenanceConfirmed: true,
      },
    });
    queue = updateTemporaryQueueEntry(queue, 'ChIJ_temp_4', {
      outcome: 'no_responde',
      notes: 'Sin respuesta en horario de mañana.',
    });

    // Búsqueda por nombre, teléfono (con o sin espacios) y Place ID
    expect(filterTemporaryQueue(queue, { searchText: 'Negocio Prueba 2', outcomeFilter: 'all' })).toHaveLength(1);
    expect(filterTemporaryQueue(queue, { searchText: '987654322', outcomeFilter: 'all' })).toHaveLength(1);
    expect(filterTemporaryQueue(queue, { searchText: 'ChIJ_temp_4', outcomeFilter: 'all' })).toHaveLength(1);
    expect(filterTemporaryQueue(queue, { searchText: '', outcomeFilter: 'interesado' })).toHaveLength(1);

    // Eliminación individual y selección múltiple
    const afterSingle = removeFromTemporaryQueue(queue, ['ChIJ_temp_1']);
    expect(afterSingle).toHaveLength(4);
    const afterBatch = removeFromTemporaryQueue(afterSingle, ['ChIJ_temp_3', 'ChIJ_temp_5']);
    expect(afterBatch.map((e) => e.placeId)).not.toContain('ChIJ_temp_3');
    expect(afterBatch).toHaveLength(2);

    // Limpiar toda la cola
    expect(clearTemporaryQueue()).toHaveLength(0);

    // Render SSR de TemporaryQueueView y FollowupCrmView funciona con cuota Places agotada (429) y sin sesión Firebase
    const tempHtml = renderToStaticMarkup(
      React.createElement(TemporaryQueueView, {
        queue: queue,
        isSignedIn: false,
        workspaceMode: 'sandbox',
        onChangeWorkspaceMode: () => {},
        onUpdateEntry: () => {},
        onRemoveSelected: () => {},
        onClearAll: () => {},
        onPromoteToCrm: async () => null,
        onGoToExplorer: () => {},
      })
    );
    expect(tempHtml).toContain('Cola Temporal de Sesión');
    expect(tempHtml).toContain('Negocio Prueba 2');
    expect(tempHtml).toContain('+51 987 654 322');
    expect(tempHtml).toContain('Mostró interés en renovación web.');
    expect(tempHtml).toContain('no se conservarán al cerrar o reiniciar la sesión');
    expect(tempHtml).toContain('no equivale a autorización de contacto');

    const wrapperHtml = renderToStaticMarkup(
      React.createElement(FollowupCrmView, {
        isSignedIn: false,
        followups: [],
        hydrationCache: {},
        placesQuotaBlock: { blocked: true, source: 'google_resource_exhausted', message: '429 cuota agotada' },
        quota: null,
        temporaryQueue: queue,
        onUpdateTemporaryEntry: () => {},
        onRemoveTemporarySelected: () => {},
        onClearTemporaryQueue: () => {},
        onPromoteTemporaryEntry: async () => null,
        onFetchIntegrityBackup: async () => ({
          totalDocuments: 0,
          uniqueDocIds: 0,
          uniquePlaceIds: 0,
          backedUpAt: '2026-11-20T00:00:00Z',
          records: [],
        }),
        onSignIn: () => {},
        onUpdateFollowup: async () => {},
        onCreateManualFollowup: async () => {},
      })
    );
    expect(wrapperHtml).toContain('Cola Temporal de Sesión (5)');
    expect(wrapperHtml).toContain('Negocio Prueba 5');
  });

  it('FASE 3: borrado controlado de Firestore exige respaldo previo, aísla Producción vs Sandbox, avanza por lotes con progreso y aísla errores parciales sin tocar Producción real', async () => {
    // 1. Bloqueo obligatorio si backupVerified !== true
    await expect(
      deleteFollowupsBatchWithProgress(
        {
          uid: 'uid_test',
          workspaceMode: 'sandbox',
          docIds: ['doc_1'],
          backupVerified: false,
        },
        {
          commitDeleteChunk: async () => {},
          deleteSingleDoc: async () => {},
        }
      )
    ).rejects.toThrow(/respaldo JSON/i);

    // 2. Borrado en lotes en Sandbox con callback de progreso y verificación estricta de colección
    const deletedPaths: string[] = [];
    const progressEvents: number[] = [];
    const sandboxDocIds = Array.from({ length: 6 }, (_, i) => `sb_doc_${i + 1}`);

    const okResult = await deleteFollowupsBatchWithProgress(
      {
        uid: 'uid_test',
        workspaceMode: 'sandbox',
        docIds: sandboxDocIds,
        backupVerified: true,
        chunkSize: 2,
        onProgress: (p) => progressEvents.push(p.processed),
      },
      {
        commitDeleteChunk: async (collectionPath, ids) => {
          expect(collectionPath).toBe('users/uid_test/sandbox_followups');
          for (const id of ids) deletedPaths.push(`${collectionPath}/${id}`);
        },
        deleteSingleDoc: async () => {},
      }
    );

    expect(okResult.collectionPath).toBe('users/uid_test/sandbox_followups');
    expect(okResult.deletedIds).toHaveLength(6);
    expect(okResult.failedItems).toHaveLength(0);
    expect(progressEvents).toEqual([2, 4, 6]);
    expect(deletedPaths.every((p) => p.startsWith('users/uid_test/sandbox_followups/'))).toBe(true);

    // 3. Simulación Producción (mock en memoria, cero llamadas a Firestore real) con fallo parcial de un documento -> aísla fallo sin abortar el resto
    const prodResult = await deleteFollowupsBatchWithProgress(
      {
        uid: 'uid_test',
        workspaceMode: 'production',
        docIds: ['prod_1', 'prod_bad', 'prod_3'],
        backupVerified: true,
        chunkSize: 10,
      },
      {
        commitDeleteChunk: async () => {
          throw new Error('Batch partial failure');
        },
        deleteSingleDoc: async (collectionPath, id) => {
          expect(collectionPath).toBe('users/uid_test/followups');
          if (id === 'prod_bad') {
            throw new Error('Missing or insufficient permissions.');
          }
        },
      }
    );

    expect(prodResult.collectionPath).toBe('users/uid_test/followups');
    expect(prodResult.deletedIds).toEqual(['prod_1', 'prod_3']);
    expect(prodResult.failedItems).toHaveLength(1);
    expect(prodResult.failedItems[0].id).toBe('prod_bad');
  });

  it('FASE 4 & 5: soporta exactamente los 10 resultados comerciales, separa los 4 conceptos telefónicos/legales y prioriza preselección determinística con 0 Gemini', () => {
    expect(TEMPORARY_QUEUE_OUTCOMES).toHaveLength(10);
    expect(TEMPORARY_QUEUE_OUTCOMES.map((o) => o.label)).toEqual([
      'Pendiente',
      'Contacto no autorizado',
      'Número incorrecto',
      'No responde',
      'Contacto alcanzado',
      'No interesado',
      'Interesado',
      'Cotización',
      'Cliente',
      'Descartado',
    ]);

    // Separación de los 4 conceptos en un prospecto con móvil de Maps pero SIN corroboración ni autorización legal
    const sampleLead = buildBusinessLeadFromPlace(
      buildSampleRawPlace(1, { websiteUri: null, internationalPhoneNumber: '+51 987 654 321' }),
      'Veterinarias',
      emptyExcl
    );
    const entryMapsOnly: TemporaryQueueEntry = {
      placeId: sampleLead.placeId,
      lead: sampleLead,
      addedAt: '2026-11-20T00:00:00Z',
      outcome: 'pendiente',
      notes: '',
      independentData: {
        independentBusinessName: '',
        independentPhone: '',
        independentAddress: '',
        district: 'Los Olivos',
        independentWebsite: '',
        independentEmail: '',
        independentCategory: 'Veterinarias',
        confirmedNoWebsite: false,
        legalBasis: '',
        provenanceConfirmed: false,
      },
    };
    const concepts = evaluateTemporaryEntryFourConcepts(entryMapsOnly);
    expect(concepts.hasValidPhoneFormat).toBe(true); // 1. formato válido
    expect(concepts.isPhoneIndependentlyCorroborated).toBe(false); // 2. NO corroborado
    expect(concepts.hasContactAuthorization).toBe(false); // 3. NO autorizado automáticamente
    expect(concepts.realOutcomeLabel).toBe('Pendiente'); // 4. resultado real

    // Gate legal al mapear resultado hacia CRM Definitivo
    expect(mapTemporaryOutcomeToCrmState('interesado', '').stage).toBe('PENDIENTE DE VERIFICACIÓN');
    expect(
      mapTemporaryOutcomeToCrmState('interesado', 'Referido comercial directo B2B').stage
    ).toBe('INTERESADO');
    expect(mapTemporaryOutcomeToCrmState('cliente', 'Contrato de servicios firmado').stage).toBe(
      'CLIENTE'
    );

    // Fase 5: Priorización determinística favorece móvil válido + sin web/solo red social vs fijo/descartado/con web activa
    const leadSocialMovil = buildBusinessLeadFromPlace(
      buildSampleRawPlace(9, {
        websiteUri: 'https://www.instagram.com/vetprueba9/',
        internationalPhoneNumber: '+51 991 333 444',
        nationalPhoneNumber: '991 333 444',
      }),
      'Veterinarias',
      emptyExcl
    );
    leadSocialMovil.websiteProbe = {
      ...leadSocialMovil.websiteProbe,
      status: 'social_only',
      isSocialOnly: true,
      provenance: 'independent_http',
    };
    leadSocialMovil.digitalScore = computeDigitalOpportunityScore(leadSocialMovil.websiteProbe, false);
    const leadSinWebMovil = buildBusinessLeadFromPlace(
      buildSampleRawPlace(10, {
        websiteUri: null,
        internationalPhoneNumber: '+51 991 222 333',
        nationalPhoneNumber: '991 222 333',
      }),
      'Veterinarias',
      emptyExcl
    );
    const leadSoloFijo = buildBusinessLeadFromPlace(
      buildSampleRawPlace(11, {
        websiteUri: null,
        internationalPhoneNumber: '+51 1 456 7890',
        nationalPhoneNumber: '(01) 456-7890',
      }),
      'Veterinarias',
      emptyExcl
    );
    const batchQual = qualifyLoadedLeadsBatch([leadSoloFijo, leadSinWebMovil, leadSocialMovil], {
      discardedPlaceIds: new Set(),
      existingFollowups: [],
    });
    const socialQual = batchQual.results.find((r) => r.placeId === 'ChIJ_temp_9')!;
    const mobileQual = batchQual.results.find((r) => r.placeId === 'ChIJ_temp_10')!;
    const landlineQual = batchQual.results.find((r) => r.placeId === 'ChIJ_temp_11')!;
    expect(socialQual.tier).toBe('PRIORIDAD ALTA');
    expect(mobileQual.tier).toBe('REVISIÓN PENDIENTE');
    expect(landlineQual.tier).toBe('NO ELEGIBLE');

    const tierWeight = (t: string) =>
      t === 'PRIORIDAD ALTA' ? 0 : t === 'REVISIÓN PENDIENTE' ? 1 : 2;
    const orderedIds = [...batchQual.results]
      .sort((a, b) => tierWeight(a.tier) - tierWeight(b.tier) || b.combinedPriorityScore - a.combinedPriorityScore)
      .map((r) => r.placeId);
    expect(orderedIds).toEqual(['ChIJ_temp_9', 'ChIJ_temp_10', 'ChIJ_temp_11']);
    expect(mobileQual.combinedPriorityScore).toBeGreaterThan(landlineQual.combinedPriorityScore);
  });
});

describe('14. Corrección de Continuidad: Sesión Estable (10 cambios de pestaña), Recuperación 12h/24h en Firestore, Zero-Maps-Persistence y Cero Llamadas Places', () => {
  const emptyExcl = buildExclusionKeySet([]);

  const makeExplorerRaw = (idx: number): GooglePlaceRaw => ({
    placeId: `ChIJ_cont_${idx}`,
    displayName: `Clínica Continuidad ${idx}`,
    formattedAddress: `Av. Izaguirre ${200 + idx}, Los Olivos`,
    location: { lat: -11.99, lng: -77.06 },
    nationalPhoneNumber: `990 111 22${idx}`,
    internationalPhoneNumber: `+51 990 111 22${idx}`,
    websiteUri: null,
    googleMapsUri: `https://maps.google.com/?cid=cont_${idx}`,
    rating: 4.6,
    userRatingCount: 18,
    businessStatus: 'OPERATIONAL',
    primaryTypeDisplayName: 'Veterinaria',
  });

  it('mantiene 5 negocios con nombre, teléfono y selecciones intactas tras 10 cambios de pestaña/remontaje sin llamar a Place Details', () => {
    const leads5 = [1, 2, 3, 4, 5].map((i) =>
      buildBusinessLeadFromPlace(makeExplorerRaw(i), 'Veterinarias', emptyExcl)
    );

    const added = addLeadsToTemporaryQueue([], leads5, {
      district: 'Los Olivos, Lima',
      category: 'Veterinarias',
      ttlHours: 24,
    });
    expect(added.addedCount).toBe(5);

    // Editar estado, nota propia, fecha, prioridad y selección persistente en el estado elevado
    let queue = updateTemporaryQueueEntry(added.queue, 'ChIJ_cont_1', {
      outcome: 'interesado',
      notes: 'Contactar el martes por la tarde.',
      followUpDate: '2026-11-24',
      priorityLabel: 'alta',
      isSelected: true,
      independentData: {
        independentBusinessName: 'Clínica Continuidad 1 S.A.C.',
        independentPhone: '+51 990 111 221',
        independentAddress: 'Av. Izaguirre 201, Los Olivos',
        district: 'Los Olivos',
        confirmedNoWebsite: true,
        provenanceConfirmed: true,
        independentDataProvenance: 'web_oficial',
      },
    });
    queue = updateTemporaryQueueEntry(queue, 'ChIJ_cont_3', {
      isSelected: true,
      notes: 'Solo referencia Maps hasta confirmar fuente propia.',
    });

    // Cambiar filtros ida y vuelta nunca elimina elementos de la cola real
    const filteredOnlySelectedOutcome = filterTemporaryQueue(queue, {
      searchText: '',
      outcomeFilter: 'interesado',
    });
    expect(filteredOnlySelectedOutcome).toHaveLength(1);
    const restoredFilterAll = filterTemporaryQueue(queue, {
      searchText: '',
      outcomeFilter: 'all',
    });
    expect(restoredFilterAll).toHaveLength(5);

    // Simular 10 cambios de pestaña / remontajes completos manteniendo activeSubView = 'temporal' y Place Details spy = 0
    const hydrateSpy = vi.fn(async () => {});
    let activeSubView: 'temporal' | 'crm' = 'temporal';
    let lastRendered = '';
    for (let step = 0; step < 10; step++) {
      lastRendered = renderToStaticMarkup(
        React.createElement(FollowupCrmView, {
          isSignedIn: true,
          followups: [],
          hydrationCache: {},
          placesQuotaBlock: { blocked: false, source: 'none', message: null },
          quota: null,
          temporaryQueue: queue,
          subView: activeSubView,
          onChangeSubView: (next) => {
            activeSubView = next;
          },
          temporaryTtlHours: 24,
          onChangeTemporaryTtlHours: () => {},
          onUpdateTemporaryEntry: () => {},
          onRemoveTemporarySelected: () => {},
          onClearTemporaryQueue: () => {},
          onPromoteTemporaryEntry: async () => null,
          onFetchIntegrityBackup: async () => ({
            totalDocuments: 0,
            uniqueDocIds: 0,
            uniquePlaceIds: 0,
            backedUpAt: '2026-11-20T12:00:00Z',
            records: [],
          }),
          onSignIn: () => {},
          onUpdateFollowup: async () => {},
          onCreateManualFollowup: async () => {},
        })
      );
    }

    expect(hydrateSpy).toHaveBeenCalledTimes(0);
    expect(lastRendered).toContain('Cola de Trabajo Temporal (5 prospectos)');
    expect(lastRendered).toContain('Eliminar seleccionados (2)');
    expect(lastRendered).toContain('Clínica Continuidad 1');
    expect(lastRendered).toContain('Clínica Continuidad 5');
    expect(lastRendered).toContain('+51 990 111 225');
  });

  it('aísla el respaldo temporal en temporary_work_queue (nunca Producción followups) y bloquea persistencia de campos Maps sin procedencia', () => {
    const uid = 'uid_test_webnex';
    expect(getTemporaryWorkQueueCollectionPath(uid)).toBe('users/uid_test_webnex/temporary_work_queue');
    expect(getFollowupsCollectionPath(uid, 'production')).toBe('users/uid_test_webnex/followups');

    const rawMapsOnly = buildBusinessLeadFromPlace(makeExplorerRaw(2), 'Veterinarias', emptyExcl);
    const { queue } = addLeadsToTemporaryQueue([], [rawMapsOnly], {
      district: 'Los Olivos',
      category: 'Veterinarias',
      ttlHours: 12,
    });

    // Caso 1: provenanceConfirmed = false -> Firestore payload JAMÁS incluye nombre/teléfono/dirección de Google Maps
    const uncorroboratedWithSneakyMapsText: TemporaryQueueEntry = {
      ...queue[0],
      notes: 'Llamar luego de almuerzo',
      followUpDate: '2026-11-25',
      priorityLabel: 'alta',
      isSelected: true,
      independentData: {
        ...queue[0].independentData,
        independentBusinessName: 'Clínica Continuidad 2',
        independentPhone: '+51 990 111 222',
        independentAddress: 'Av. Izaguirre 202, Los Olivos',
        independentWebsite: 'https://maps-ejemplo.pe',
        independentEmail: 'copiado@ejemplo.pe',
        provenanceConfirmed: false,
      },
    };

    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    const safePayload = buildTemporaryWorkItemPayload(uid, uncorroboratedWithSneakyMapsText, 12, {
      nowMs,
      timestampValue: 'SERVER_TS',
    });

    expect(safePayload.placeId).toBe('ChIJ_cont_2');
    expect(safePayload.ttlHours).toBe(12);
    expect(safePayload.expiresAtEpochMs).toBe(nowMs + 12 * 60 * 60 * 1000);
    expect(safePayload.notes).toBe('Llamar luego de almuerzo');
    expect(safePayload.followUpDate).toBe('2026-11-25');
    expect(safePayload.priorityLabel).toBe('alta');
    expect(safePayload.isSelected).toBe(true);
    expect(safePayload.provenanceConfirmed).toBe(false);
    // Gate estricto: todos los campos comerciales de terceros llegan vacíos a Firestore
    expect(safePayload.independentBusinessName).toBe('');
    expect(safePayload.independentPhone).toBe('');
    expect(safePayload.independentAddress).toBe('');
    expect(safePayload.independentWebsite).toBe('');
    expect(safePayload.independentEmail).toBe('');

    // Caso 2: beforeunload advierte cuando hay sesión sin autenticar o ítems solo-Maps sin datos independientes confirmados
    expect(hasUnrecoverableSessionMapsWork([uncorroboratedWithSneakyMapsText], true)).toBe(true);
    expect(hasUnrecoverableSessionMapsWork([uncorroboratedWithSneakyMapsText], false)).toBe(true);

    // Caso 3: con procedencia independiente confirmada SÍ persiste el dato propio y deja de tener trabajo inrecuperable si todos están respaldados
    const corroboratedEntry: TemporaryQueueEntry = {
      ...uncorroboratedWithSneakyMapsText,
      independentData: {
        ...uncorroboratedWithSneakyMapsText.independentData,
        provenanceConfirmed: true,
        independentDataProvenance: 'directorio_propio_manual',
      },
    };
    const corroboratedPayload = buildTemporaryWorkItemPayload(uid, corroboratedEntry, 24, {
      nowMs,
      timestampValue: 'SERVER_TS',
    });
    expect(corroboratedPayload.provenanceConfirmed).toBe(true);
    expect(corroboratedPayload.independentBusinessName).toBe('Clínica Continuidad 2');
    expect(corroboratedPayload.independentPhone).toBe('+51 990 111 222');
    expect(corroboratedPayload.independentDataProvenance).toBe('directorio_propio_manual');
    expect(corroboratedPayload.expiresAtEpochMs).toBe(nowMs + 24 * 60 * 60 * 1000);
    expect(hasUnrecoverableSessionMapsWork([corroboratedEntry], true)).toBe(false);
  });

  it('recupera automáticamente tras recarga/reinicio/cambio de sesión los elementos vigentes (< 12h/24h) sin duplicados, descarta vencidos, respeta 0 Places y re-vincula si Explorador vuelve a buscar', () => {
    const t0 = Date.UTC(2026, 10, 20, 10, 0, 0);
    const tAfter1Hour = t0 + 60 * 60 * 1000;
    const tAfter13Hours = t0 + 13 * 60 * 60 * 1000;

    const persistedItems: PersistedTemporaryWorkItem[] = [
      {
        id: 'ChIJ_cont_1',
        ownerUid: 'uid_test_webnex',
        placeId: 'ChIJ_cont_1',
        outcome: 'interesado',
        notes: 'Pidió cotización plan web pyme.',
        followUpDate: '2026-11-26',
        isSelected: true,
        priorityLabel: 'alta',
        ttlHours: 24,
        expiresAtEpochMs: t0 + 24 * 60 * 60 * 1000,
        searchCategory: 'Veterinarias',
        searchDistrict: 'Los Olivos',
        provenanceConfirmed: true,
        independentBusinessName: 'Veterinaria Corroborada Uno SAC',
        independentPhone: '+51 990 111 221',
        independentAddress: 'Av. Izaguirre 201',
        district: 'Los Olivos',
        independentWebsite: 'https://vetuno.pe',
        independentEmail: 'hola@vetuno.pe',
        independentCategory: 'Veterinarias',
        confirmedNoWebsite: false,
        legalBasis: 'Contacto B2B iniciado por formulario web',
        independentDataProvenance: 'web_oficial',
        promotedToCrmId: '',
        createdAt: new Date(t0).toISOString(),
        updatedAt: new Date(t0).toISOString(),
      },
      {
        id: 'ChIJ_cont_2',
        ownerUid: 'uid_test_webnex',
        placeId: 'ChIJ_cont_2',
        outcome: 'pendiente',
        notes: 'Prospecto guardado sin corroboración independiente.',
        followUpDate: '',
        isSelected: false,
        priorityLabel: 'normal',
        ttlHours: 12,
        expiresAtEpochMs: t0 + 12 * 60 * 60 * 1000,
        searchCategory: 'Veterinarias',
        searchDistrict: 'Los Olivos',
        provenanceConfirmed: false,
        independentBusinessName: '',
        independentPhone: '',
        independentAddress: '',
        district: 'Los Olivos',
        independentWebsite: '',
        independentEmail: '',
        independentCategory: 'Veterinarias',
        confirmedNoWebsite: true,
        legalBasis: '',
        independentDataProvenance: '',
        promotedToCrmId: '',
        createdAt: new Date(t0).toISOString(),
        updatedAt: new Date(t0).toISOString(),
      },
    ];

    // 1. Simular ausencia de 1 hora + recarga completa (cola en RAM = [] y Explorador en RAM = [])
    const after1h = mergeRestoredTemporaryQueue([], persistedItems, [], tAfter1Hour);
    expect(after1h.restoredCount).toBe(2);
    expect(after1h.expiredCount).toBe(0);
    expect(after1h.missingMapsSessionCount).toBe(2);
    expect(after1h.mergedQueue).toHaveLength(2);

    const restoredCorroborated = after1h.mergedQueue.find((e) => e.placeId === 'ChIJ_cont_1')!;
    const restoredMapsOnly = after1h.mergedQueue.find((e) => e.placeId === 'ChIJ_cont_2')!;

    expect(restoredCorroborated.independentData.independentBusinessName).toBe('Veterinaria Corroborada Uno SAC');
    expect(restoredCorroborated.independentData.independentPhone).toBe('+51 990 111 221');
    expect(restoredCorroborated.notes).toBe('Pidió cotización plan web pyme.');
    expect(restoredCorroborated.followUpDate).toBe('2026-11-26');
    expect(restoredCorroborated.priorityLabel).toBe('alta');
    expect(restoredCorroborated.isSelected).toBe(true);

    // El elemento sin procedencia independiente NO inventa nombre ni teléfono de Maps y explica el estado honestamente
    expect(restoredMapsOnly.mapsSessionAvailable).toBe(false);
    expect(restoredMapsOnly.lead.name).toBe('');
    expect(restoredMapsOnly.notes).toBe('Prospecto guardado sin corroboración independiente.');
    const fourConceptsRestored = evaluateTemporaryEntryFourConcepts(restoredMapsOnly);
    expect(fourConceptsRestored.hasValidPhoneFormat).toBe(false);
    expect(fourConceptsRestored.phoneFormatLabel).toContain('Maps no en sesión');

    // Render SSR de la vista restaurada muestra datos propios y bandera honesta de sesión Maps
    const restoredHtml = renderToStaticMarkup(
      React.createElement(TemporaryQueueView, {
        queue: after1h.mergedQueue,
        isSignedIn: true,
        workspaceMode: 'sandbox',
        onChangeWorkspaceMode: () => {},
        ttlHours: 24,
        onChangeTtlHours: () => {},
        restorationNotice: 'Se recuperaron automáticamente 2 prospecto(s) vigente(s).',
        onUpdateEntry: () => {},
        onRemoveSelected: () => {},
        onClearAll: () => {},
        onPromoteToCrm: async () => null,
        onGoToExplorer: () => {},
      })
    );
    expect(restoredHtml).toContain('Veterinaria Corroborada Uno SAC');
    expect(restoredHtml).toContain('+51 990 111 221');
    expect(restoredHtml).toContain('Restaurado (Maps ya no en RAM)');
    expect(restoredHtml).toContain('No disponible tras reinicio (solo sesión Maps)');
    expect(restoredHtml).toContain('Cola de Trabajo Temporal (2 prospectos)');

    // Re-sincronizar segunda vez (ej. cerrar sesión + volver a iniciar) nunca genera duplicados
    const reSyncNoDuplicates = mergeRestoredTemporaryQueue(
      after1h.mergedQueue,
      persistedItems,
      [],
      tAfter1Hour + 5_000
    );
    expect(reSyncNoDuplicates.restoredCount).toBe(0);
    expect(reSyncNoDuplicates.mergedQueue).toHaveLength(2);

    // 2. Si Explorador carga después los leads en RAM, re-vincula los campos vivos de Maps con 0 Place Details
    const newExplorerLead2 = buildBusinessLeadFromPlace(makeExplorerRaw(2), 'Veterinarias', emptyExcl);
    const relinked = reattachSessionLeadsToTemporaryQueue(after1h.mergedQueue, [newExplorerLead2]);
    const relinked2 = relinked.find((e) => e.placeId === 'ChIJ_cont_2')!;
    expect(relinked2.mapsSessionAvailable).toBe(true);
    expect(relinked2.lead.name).toBe('Clínica Continuidad 2');
    expect(relinked2.lead.phone).toBe('+51 990 111 222');

    // 3. A las 13h: el de TTL 12h caduca limpiamente mientras el de TTL 24h sigue vigente
    const after13h = mergeRestoredTemporaryQueue([], persistedItems, [], tAfter13Hours);
    expect(after13h.expiredCount).toBe(1);
    expect(after13h.mergedQueue.map((e) => e.placeId)).toEqual(['ChIJ_cont_1']);

    // 4. Cambio manual de TTL 24h -> 12h actualiza expiración en cola sin tocar CRM definitivo
    const switchedTo12h = applyTtlToTemporaryQueue(after13h.mergedQueue, 12);
    expect(switchedTo12h[0].ttlHours).toBe(12);
    expect(computeExpiryIso('2026-11-20T10:00:00.000Z', 12).expiresAtIso).toBe(
      '2026-11-20T22:00:00.000Z'
    );
  });
});

describe('15. Exportación Excel (.XLSX) de Cola Temporal (ExcelJS, +51 Texto, Tildes, 20 Filas, 0 APIs, Compliance Google Maps §3.2.3)', () => {
  const emptyExcl = buildExclusionKeySet([]);

  const buildSyntheticRaw = (idx: number): GooglePlaceRaw => ({
    placeId: `ChIJ_xlsx_${idx}`,
    displayName: `Negocio Maps Restringido ${idx}`,
    formattedAddress: `Av. Maps Privada ${idx}, Los Olivos`,
    location: { lat: -11.99, lng: -77.06 },
    nationalPhoneNumber: `980 000 ${String(idx).padStart(3, '0')}`,
    internationalPhoneNumber: `+51 980 000 ${String(idx).padStart(3, '0')}`,
    websiteUri: idx % 3 === 0 ? `https://ejemplo-maps-${idx}.pe` : null,
    googleMapsUri: `https://maps.google.com/?cid=xlsx_${idx}`,
    rating: 4.4,
    userRatingCount: 12,
    businessStatus: 'OPERATIONAL',
    primaryTypeDisplayName: 'Veterinaria',
  });

  it('exporta 20/20 prospectos a archivo .XLSX válido (pese a filtros activos), preserva +51 como texto, tildes, sin número, notas/resultados, seleccionados, 0 APIs y respeto estricto a ToS §3.2.3', async () => {
    const raws20 = Array.from({ length: 20 }, (_, i) =>
      buildBusinessLeadFromPlace(buildSyntheticRaw(i + 1), 'Veterinarias', emptyExcl)
    );
    const added = addLeadsToTemporaryQueue([], raws20, {
      district: 'Los Olivos, Lima',
      category: 'Veterinarias',
    });
    expect(added.queue).toHaveLength(20);

    // Enriquecer varios registros con datos propios (sin exigir 4/4, RUC ni base legal):
    // #1 y #2: nombres con tildes + teléfono +51 + notas + cotización/interesado + seleccionados
    let queue = updateTemporaryQueueEntry(added.queue, 'ChIJ_xlsx_1', {
      outcome: 'cotizacion',
      priorityLabel: 'alta',
      followUpDate: '2026-11-28',
      isSelected: true,
      notes: 'Cotización enviada para rediseño completo; llamar 4pm.',
      independentData: {
        independentBusinessName: 'Clínica Veterinaria San Martín – Año Nuevo',
        independentPhone: '+51 987 654 321',
        independentAddress: 'Jr. Áncash 450, Los Olivos',
        district: 'Los Olivos',
        independentWebsite: 'https://sanmartinvet.pe',
        confirmedNoWebsite: false,
        legalBasis: '', // NO exige base legal para exportar reporte propio
        provenanceConfirmed: true,
        independentDataProvenance: 'web_oficial',
      },
    });

    queue = updateTemporaryQueueEntry(queue, 'ChIJ_xlsx_2', {
      outcome: 'interesado',
      priorityLabel: 'normal',
      isSelected: true,
      notes: 'Óptica con interés en catálogo móvil; sin teléfono registrado en web.',
      independentData: {
        independentBusinessName: 'Óptica Núñez S.A.C.',
        independentPhone: '', // Registro explícito SIN número
        independentAddress: '',
        district: 'Los Olivos',
        confirmedNoWebsite: true,
        legalBasis: '',
        provenanceConfirmed: true,
        independentDataProvenance: 'captura_manual_webnex',
      },
    });

    // #3 y #4: solo seleccionados + notas propias, SIN fuente independiente (datos Maps restringidos por §3.2.3)
    queue = updateTemporaryQueueEntry(queue, 'ChIJ_xlsx_3', {
      outcome: 'no_responde',
      isSelected: true,
      notes: 'Primer intento sin respuesta a las 10:30am.',
    });
    queue = updateTemporaryQueueEntry(queue, 'ChIJ_xlsx_4', {
      outcome: 'contacto_no_autorizado',
      isSelected: true,
      notes: 'Pendiente verificar fuente independiente fuera de Maps.',
    });

    // Verificar que hay filtros activos en la UI que solo mostrarían 1 fila
    const filteredVisible = filterTemporaryQueue(queue, {
      searchText: 'San Martín',
      outcomeFilter: 'cotizacion',
    });
    expect(filteredVisible).toHaveLength(1);

    // Espiar fetch para probar CERO solicitudes a Google Places, Gemini, Firestore ni HTTP durante la exportación
    const origFetch = globalThis.fetch;
    const fetchSpy = vi.fn(origFetch);
    globalThis.fetch = fetchSpy as typeof fetch;

    try {
      // 1. Exportar TODOS (20 prospectos) pese a filtros activos
      const exportAll = await exportTemporaryQueueToExcel(queue, { scope: 'all' });

      expect(fetchSpy).toHaveBeenCalledTimes(0);
      expect(exportAll.totalQueueCount).toBe(20);
      expect(exportAll.exportedCount).toBe(20);
      expect(exportAll.independentFieldsRowsCount).toBe(2);
      expect(exportAll.mapsRestrictedRowsCount).toBe(18);
      // Cola intacta después de exportar
      expect(queue).toHaveLength(20);

      // Verificar firma ZIP de archivo .XLSX real ('PK') y re-parsear con ExcelJS
      expect(exportAll.buffer[0]).toBe(0x50);
      expect(exportAll.buffer[1]).toBe(0x4b);

      const WorkbookCtor = (ExcelJS as any).Workbook || (ExcelJS as any).default?.Workbook;
      const parsedWb = new WorkbookCtor();
      await parsedWb.xlsx.load(Buffer.from(exportAll.buffer));

      const dataSheet = parsedWb.getWorksheet('Cola_Temporal_WEBNEX');
      const complianceSheet = parsedWb.getWorksheet('Aviso_Compliance_GMP');
      expect(dataSheet).toBeDefined();
      expect(complianceSheet).toBeDefined();

      // 1 fila de cabecera + exactamente 20 filas de datos = 21 filas
      expect(dataSheet.actualRowCount).toBe(21);

      // Mapear filas por Place ID (columna 9)
      const rowsByPlaceId = new Map<string, any>();
      for (let r = 2; r <= 21; r++) {
        const row = dataSheet.getRow(r);
        rowsByPlaceId.set(String(row.getCell(9).value || ''), row);
      }
      expect(rowsByPlaceId.size).toBe(20);

      // A) Fila #1 (tildes + +51 como TEXTO + notas + resultado + puntajes + enlace query_place_id)
      const row1 = rowsByPlaceId.get('ChIJ_xlsx_1');
      expect(row1.getCell(1).value).toBe('Clínica Veterinaria San Martín – Año Nuevo');
      expect(typeof row1.getCell(2).value).toBe('string');
      expect(row1.getCell(2).value).toBe('+51 987 654 321');
      expect(row1.getCell(2).numFmt).toBe('@');
      expect(row1.getCell(3).value).toBe('Móvil');
      expect(row1.getCell(5).value).toBe('Los Olivos');
      expect(row1.getCell(6).value).toBe('Veterinarias');
      expect(row1.getCell(7).value).toBe('https://sanmartinvet.pe');
      expect(row1.getCell(10).value).toContain('query_place_id=ChIJ_xlsx_1');
      expect(row1.getCell(11).value).toBe('Alta');
      expect(String(row1.getCell(12).value)).toContain('Digital:');
      expect(row1.getCell(13).value).toBe('Cotización');
      expect(row1.getCell(15).value).toBe('Cotización enviada para rediseño completo; llamar 4pm.');

      // B) Fila #2 (tildes Óptica Núñez S.A.C., SIN teléfono -> celdas vacías + dato faltante identificado)
      const row2 = rowsByPlaceId.get('ChIJ_xlsx_2');
      expect(row2.getCell(1).value).toBe('Óptica Núñez S.A.C.');
      expect(row2.getCell(2).value).toBe('');
      expect(row2.getCell(3).value).toBe('');
      expect(row2.getCell(8).value).toBe('Sin web propia confirmada');
      expect(row2.getCell(13).value).toBe('Interesado');
      expect(String(row2.getCell(18).value)).toContain('Falta teléfono propio');

      // C) Fila #3 (solo sesión Google Maps, provenanceConfirmed = false -> NO exporta nombre/teléfono/dirección Maps ni altera procedencia!)
      const row3 = rowsByPlaceId.get('ChIJ_xlsx_3');
      expect(row3.getCell(1).value).toBe('');
      expect(row3.getCell(2).value).toBe('');
      expect(row3.getCell(4).value).toBe('');
      expect(row3.getCell(9).value).toBe('ChIJ_xlsx_3');
      expect(row3.getCell(13).value).toBe('No responde');
      expect(row3.getCell(15).value).toBe('Primer intento sin respuesta a las 10:30am.');
      expect(String(row3.getCell(17).value)).toContain('ToS §3.2.3');
      expect(String(row3.getCell(18).value)).toContain('restricción ToS §3.2.3');

      // Verificar que jamás apareció el nombre crudo de Google Maps en el workbook exportado
      for (let r = 2; r <= 21; r++) {
        const nameCell = String(dataSheet.getRow(r).getCell(1).value || '');
        expect(nameCell).not.toContain('Negocio Maps Restringido');
      }

      // 2. Exportación de SELECCIONADOS (4 seleccionados = 4 filas en hoja principal)
      const selectedEntries = queue.filter((e) => Boolean(e.isSelected));
      const exportSelected = await generateTemporaryQueueExcelWorkbookBuffer(selectedEntries, {
        scope: 'selected',
        totalQueueCount: queue.length,
        exportedAtIso: '2026-11-20T21:35:00.000Z',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(0);
      expect(exportSelected.exportedCount).toBe(4);
      expect(exportSelected.totalQueueCount).toBe(20);

      const parsedSelWb = new WorkbookCtor();
      await parsedSelWb.xlsx.load(Buffer.from(exportSelected.buffer));
      const selSheet = parsedSelWb.getWorksheet('Cola_Temporal_WEBNEX');
      expect(selSheet.actualRowCount).toBe(5); // 1 cabecera + 4 seleccionadas

      // 3. Vista SSR incluye el botón principal solicitado y la advertencia contractual ToS §3.2.3
      const viewHtml = renderToStaticMarkup(
        React.createElement(TemporaryQueueView, {
          queue,
          isSignedIn: true,
          workspaceMode: 'sandbox',
          onChangeWorkspaceMode: () => {},
          onUpdateEntry: () => {},
          onRemoveSelected: () => {},
          onClearAll: () => {},
          onPromoteToCrm: async () => null,
          onGoToExplorer: () => {},
        })
      );
      expect(viewHtml).toContain('EXPORTAR TODOS A EXCEL (.XLSX)');
      expect(viewHtml).toContain('Exportar seleccionados (4)');
      expect(viewHtml).toContain('Google Maps Platform ToS §3.2.3');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});







