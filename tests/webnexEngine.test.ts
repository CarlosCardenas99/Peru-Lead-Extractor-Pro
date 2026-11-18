import { describe, expect, it } from 'vitest';
import { analyzePeruvianPhone } from '../utils/peruPhone';
import {
  buildExclusionKeySet,
  checkPlaceAgainstExclusions,
  parseExclusionBatchInput,
} from '../utils/exclusionUtils';
import {
  computeContactabilityScore,
  computeDigitalOpportunityScore,
  computeIndependentFunnelMetrics,
  deduplicatePlacesById,
} from '../utils/scoring';
import { isPrivateOrReservedIp, validateAndResolveSafeUrl } from '../server/ssrfGuard';
import { verifyWebsiteIndependently } from '../server/websiteVerifier';
import { DailyQuotaGuard } from '../server/quotaGuard';
import { mapGooglePlacePayload, searchPlacesNewApi } from '../server/placesService';
import { parseSubzoneGeminiResponse } from '../server/geminiSubzoneService';
import { ExclusionRecord, FollowupLeadRecord, GooglePlaceRaw } from '../types';

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
      // Mismo placeId -> debe deduplicarse
      { ...page1[0] },
      // Misma marca, distinta sucursal y distinto placeId -> debe conservarse
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

describe('2. Normalización de teléfonos peruanos sin asumir WhatsApp', () => {
  it('normaliza móviles, fijos de Lima y regionales, y maneja ausentes o inválidos', () => {
    const mobile = analyzePeruvianPhone('987-654-321');
    expect(mobile.isValidFormat).toBe(true);
    expect(mobile.e164).toBe('+51987654321');
    expect(mobile.formatted).toBe('+51 987 654 321');
    expect(mobile.lineType).toBe('mobile');
    expect(mobile.note.toLowerCase()).toContain('whatsapp no asumido');

    const lima = analyzePeruvianPhone('(01) 456-7890');
    expect(lima.isValidFormat).toBe(true);
    expect(lima.e164).toBe('+5114567890');
    expect(lima.lineType).toBe('landline_lima');

    const arequipa = analyzePeruvianPhone('+51 54 234567');
    expect(arequipa.isValidFormat).toBe(true);
    expect(arequipa.e164).toBe('+5154234567');
    expect(arequipa.lineType).toBe('landline_regional');

    const invalid = analyzePeruvianPhone('12345');
    expect(invalid.isValidFormat).toBe(false);
    expect(invalid.stage).toBe('registered_invalid');

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

    // Redirect hop targeting 169.254.169.254 must be blocked cleanly
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

describe('4. Separación de Puntuación Digital vs Contactabilidad y Métricas', () => {
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
    // Digital score stays identical regardless of contactability
    expect(computeDigitalOpportunityScore(unregisteredProbe, false).score).toBe(scoreNoPhone.score);
  });

  it('calcula las 7 métricas independientes correctamente', () => {
    const followups: FollowupLeadRecord[] = [
      {
        id: '1',
        ownerUid: 'u1',
        placeId: 'p1',
        independentBusinessName: 'Negocio A',
        district: 'Los Olivos',
        confirmedNoWebsite: true,
        independentWebsiteStatus: 'confirmed_none',
        independentPhone: '+51 987 654 321',
        phoneStage: 'contact_reached',
        independentEmail: '',
        independentDigitalScore: 100,
        independentContactScore: 85,
        stage: 'Cliente',
        notes: '',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: '2',
        ownerUid: 'u1',
        placeId: 'p2',
        independentBusinessName: 'Negocio B',
        district: 'Miraflores',
        confirmedNoWebsite: true,
        independentWebsiteStatus: 'confirmed_none',
        independentPhone: '+51 912 345 678',
        phoneStage: 'independently_corroborated',
        independentEmail: '',
        independentDigitalScore: 100,
        independentContactScore: 70,
        stage: 'Cotización',
        notes: '',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: '3',
        ownerUid: 'u1',
        placeId: 'p3',
        independentBusinessName: 'Negocio C',
        district: 'Surco',
        confirmedNoWebsite: false,
        independentWebsiteStatus: 'unregistered',
        independentPhone: '',
        phoneStage: 'registered_valid_format',
        independentEmail: '',
        independentDigitalScore: 85,
        independentContactScore: 45,
        stage: 'Pendiente de revisión',
        notes: '',
        createdAt: '',
        updatedAt: '',
      },
    ];

    const metrics = computeIndependentFunnelMetrics([], followups);
    expect(metrics.uniqueBusinessesFound).toBe(0);
    expect(metrics.corroboratedRecords).toBe(2);
    expect(metrics.verifiableDigitalOpportunities).toBe(2);
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
    // Add a duplicate and a domain
    lines.push('+51 900 000 000');
    lines.push('https://www.cliente-actual.pe/contacto');

    const existingRecords: ExclusionRecord[] = [];
    const existingKeys = buildExclusionKeySet(existingRecords);
    const parsed = parseExclusionBatchInput(lines.join('\n'), existingKeys, 10000);

    expect(parsed.uniqueEntries).toHaveLength(4768); // 4767 phones + 1 domain
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
});
