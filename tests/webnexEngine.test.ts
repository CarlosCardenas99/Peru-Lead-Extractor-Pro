import { describe, expect, it } from 'vitest';
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
  deduplicatePlacesById,
} from '../utils/scoring';
import { isPrivateOrReservedIp, validateAndResolveSafeUrl } from '../server/ssrfGuard';
import { verifyWebsiteIndependently } from '../server/websiteVerifier';
import { extractHtmlSignals } from '../server/websiteMetadataExtractor';
import { parseGeminiAnalystResponse, sanitizeAnalystInput } from '../server/geminiAnalystService';
import { DailyQuotaGuard } from '../server/quotaGuard';
import { mapGooglePlacePayload, searchPlacesNewApi } from '../server/placesService';
import { parseSubzoneGeminiResponse } from '../server/geminiSubzoneService';
import { buildBusinessLeadFromPlace } from '../services/geminiService';
import { formatFriendlyFirestoreError } from '../services/firebaseService';
import {
  DEFAULT_SMART_FILTERS,
  ExclusionRecord,
  FollowupLeadRecord,
  GooglePlaceRaw,
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
