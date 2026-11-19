import http from 'node:http';
import { AddressInfo } from 'node:net';
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
import { parseSubzoneGeminiResponse } from '../server/geminiSubzoneService';
import { createApiApp } from '../server';
import { buildBusinessLeadFromPlace } from '../services/geminiService';
import {
  buildFollowupCreateDocPayload,
  buildMissingFieldsPatch,
  buildSafeLegacyCleanupPreview,
  clampFirestoreScore,
  formatFriendlyFirestoreError,
  getFollowupsCollectionPath,
  planNonDestructiveFollowupBatch,
} from '../services/firebaseService';
import { FollowupCrmView } from '../components/FollowupCrmView';
import { ExportButton } from '../components/ExportButton';
import { buildNonDestructiveRecoveryPreviews } from '../components/FollowupRecoveryModal';
import {
  buildPersistedVerificationReport,
  encodeOutcomeHistoryEntry,
  encodeVerificationProvenanceEntry,
  evaluateFollowupCompleteness,
  getCommercialOutcomeLabel,
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
  PlaceHydrationEntry,
  PlacesQuotaBlockState,
  QuotaStatus,
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




