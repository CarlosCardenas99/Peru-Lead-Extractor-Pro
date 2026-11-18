import { WebsiteProbeResult } from '../types';
import { DnsLookupFn, validateAndResolveSafeUrl } from './ssrfGuard';

const SOCIAL_DOMAINS = [
  'facebook.com',
  'fb.com',
  'instagram.com',
  'tiktok.com',
  'linktr.ee',
  'wa.me',
  'whatsapp.com',
  'youtube.com',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'sites.google.com',
  'bio.link',
];

function isSocialOnlyHost(hostname: string): boolean {
  const h = hostname.replace(/^www\./, '').toLowerCase();
  return SOCIAL_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

function hasAntiBotMarkers(status: number, headers: Headers, bodySnippet: string = ''): boolean {
  if (status === 403 || status === 405 || status === 429) return true;
  const cfMitigated = headers.get('cf-mitigated');
  const server = (headers.get('server') || '').toLowerCase();
  const body = bodySnippet.toLowerCase();

  if (cfMitigated) return true;
  if (
    status === 503 &&
    (server.includes('cloudflare') ||
      headers.has('cf-ray') ||
      body.includes('just a moment') ||
      body.includes('attention required') ||
      body.includes('captcha'))
  ) {
    return true;
  }
  if (
    body.includes('cloudflare') &&
    (body.includes('challenge') || body.includes('verify you are human'))
  ) {
    return true;
  }
  return false;
}

export interface VerifierDeps {
  fetchFn?: typeof fetch;
  dnsLookupFn?: DnsLookupFn;
  timeoutMs?: number;
  maxRedirects?: number;
}

/**
 * Verificador web independiente endurecido contra SSRF (incluyendo DNS y redirecciones).
 * Clasifica respuestas 403, 405, 429, timeouts, errores TLS y bloqueos antibots como
 * NO VERIFICADOS ('unverified_inconclusive'), nunca como sitios caídos.
 */
export async function verifyWebsiteIndependently(
  rawUrl: string | null | undefined,
  deps: VerifierDeps = {}
): Promise<WebsiteProbeResult> {
  const now = new Date().toISOString();
  const trimmed = (rawUrl || '').trim();

  if (!trimmed || trimmed.toLowerCase() === 'n/a') {
    return {
      checkedUrl: null,
      finalUrl: null,
      status: 'unregistered',
      httpStatus: null,
      tlsValid: null,
      isSocialOnly: false,
      inconclusiveReason: null,
      summary: 'Sin sitio web registrado en Google Maps',
      verifiedAt: now,
      provenance: 'google_absent',
    };
  }

  const fetchFn = deps.fetchFn || fetch;
  const timeoutMs = deps.timeoutMs ?? 6000;
  const maxRedirects = deps.maxRedirects ?? 5;

  let currentUrl = trimmed;
  let redirectCount = 0;

  while (redirectCount <= maxRedirects) {
    const validation = await validateAndResolveSafeUrl(currentUrl, deps.dnsLookupFn);
    if (validation.ok === false) {
      if (validation.code === 'INVALID_URL') {
        return {
          checkedUrl: trimmed,
          finalUrl: null,
          status: 'invalid_url',
          httpStatus: null,
          tlsValid: null,
          isSocialOnly: false,
          inconclusiveReason: null,
          summary: `URL inválida: ${validation.reason}`,
          verifiedAt: now,
          provenance: 'independent_http',
        };
      }
      if (validation.code === 'DNS_NOT_FOUND') {
        return {
          checkedUrl: trimmed,
          finalUrl: null,
          status: 'unreachable_verified',
          httpStatus: null,
          tlsValid: null,
          isSocialOnly: false,
          inconclusiveReason: null,
          summary: validation.reason,
          verifiedAt: now,
          provenance: 'independent_http',
        };
      }
      // SSRF_BLOCKED or transient DNS_ERROR -> classify safely without probing internal targets
      return {
        checkedUrl: trimmed,
        finalUrl: null,
        status: 'unverified_inconclusive',
        httpStatus: null,
        tlsValid: null,
        isSocialOnly: false,
        inconclusiveReason: validation.reason,
        summary: `No verificado: ${validation.reason}`,
        verifiedAt: now,
        provenance: 'independent_http',
      };
    }

    const safeTargetUrl = validation.parsedUrl.toString();

    if (isSocialOnlyHost(validation.parsedUrl.hostname)) {
      return {
        checkedUrl: trimmed,
        finalUrl: safeTargetUrl,
        status: 'social_only',
        httpStatus: null,
        tlsValid: validation.parsedUrl.protocol === 'https:',
        isSocialOnly: true,
        inconclusiveReason: null,
        summary: `Enlace apunta a red social o plataforma externa (${validation.parsedUrl.hostname})`,
        verifiedAt: now,
        provenance: 'independent_http',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let res = await fetchFn(safeTargetUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WebnexSiteCheck/1.0)',
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
      });

      // Fallback to lightweight GET if HEAD is disallowed (405 / 501)
      if (res.status === 405 || res.status === 501) {
        res = await fetchFn(safeTargetUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; WebnexSiteCheck/1.0)',
            Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
            Range: 'bytes=0-4096',
          },
        });
      }

      clearTimeout(timer);

      // Handle HTTP redirects manually so every hop goes through SSRF validation
      if (res.status >= 300 && res.status < 400) {
        const locationHeader = res.headers.get('location');
        if (!locationHeader) {
          return {
            checkedUrl: trimmed,
            finalUrl: safeTargetUrl,
            status: 'unverified_inconclusive',
            httpStatus: res.status,
            tlsValid: safeTargetUrl.startsWith('https://'),
            isSocialOnly: false,
            inconclusiveReason: `Redirección HTTP ${res.status} sin cabecera Location`,
            summary: `No verificado (HTTP ${res.status})`,
            verifiedAt: now,
            provenance: 'independent_http',
          };
        }
        currentUrl = new URL(locationHeader, safeTargetUrl).toString();
        redirectCount++;
        continue;
      }

      let bodySnippet = '';
      if (res.status >= 400) {
        try {
          bodySnippet = (await res.text()).slice(0, 1024);
        } catch {
          bodySnippet = '';
        }
      }

      if (hasAntiBotMarkers(res.status, res.headers, bodySnippet)) {
        const reason =
          res.status === 429
            ? 'Límite de tasa HTTP 429'
            : res.status === 403
            ? 'Bloqueo HTTP 403 (posible WAF/antibots)'
            : res.status === 405
            ? 'Método bloqueado HTTP 405'
            : `Bloqueo antibots detectado (HTTP ${res.status})`;

        return {
          checkedUrl: trimmed,
          finalUrl: safeTargetUrl,
          status: 'unverified_inconclusive',
          httpStatus: res.status,
          tlsValid: safeTargetUrl.startsWith('https://'),
          isSocialOnly: false,
          inconclusiveReason: reason,
          summary: `No verificado: ${reason}`,
          verifiedAt: now,
          provenance: 'independent_http',
        };
      }

      if (res.status === 404 || res.status === 410) {
        return {
          checkedUrl: trimmed,
          finalUrl: safeTargetUrl,
          status: 'unreachable_verified',
          httpStatus: res.status,
          tlsValid: safeTargetUrl.startsWith('https://'),
          isSocialOnly: false,
          inconclusiveReason: null,
          summary: `Sitio no encontrado (HTTP ${res.status})`,
          verifiedAt: now,
          provenance: 'independent_http',
        };
      }

      if (res.status >= 500) {
        return {
          checkedUrl: trimmed,
          finalUrl: safeTargetUrl,
          status: 'unverified_inconclusive',
          httpStatus: res.status,
          tlsValid: safeTargetUrl.startsWith('https://'),
          isSocialOnly: false,
          inconclusiveReason: `Error temporal del servidor HTTP ${res.status}`,
          summary: `No verificado: error de servidor HTTP ${res.status}`,
          verifiedAt: now,
          provenance: 'independent_http',
        };
      }

      if (res.status >= 200 && res.status < 300) {
        const isHttps = safeTargetUrl.startsWith('https://');
        return {
          checkedUrl: trimmed,
          finalUrl: safeTargetUrl,
          status: isHttps ? 'active_https' : 'active_http',
          httpStatus: res.status,
          tlsValid: isHttps,
          isSocialOnly: false,
          inconclusiveReason: null,
          summary: isHttps
            ? `Sitio HTTPS activo (HTTP ${res.status})`
            : `Sitio HTTP activo sin TLS/HTTPS (HTTP ${res.status})`,
          verifiedAt: now,
          provenance: 'independent_http',
        };
      }

      return {
        checkedUrl: trimmed,
        finalUrl: safeTargetUrl,
        status: 'unverified_inconclusive',
        httpStatus: res.status,
        tlsValid: safeTargetUrl.startsWith('https://'),
        isSocialOnly: false,
        inconclusiveReason: `Respuesta HTTP ${res.status} no concluyente`,
        summary: `No verificado (HTTP ${res.status})`,
        verifiedAt: now,
        provenance: 'independent_http',
      };
    } catch (err: any) {
      clearTimeout(timer);
      const msg = String(err?.message || '');
      const code = String(err?.cause?.code || err?.code || '');

      if (err?.name === 'AbortError' || code === 'ETIMEDOUT' || msg.toLowerCase().includes('timeout')) {
        return {
          checkedUrl: trimmed,
          finalUrl: safeTargetUrl,
          status: 'unverified_inconclusive',
          httpStatus: null,
          tlsValid: null,
          isSocialOnly: false,
          inconclusiveReason: 'Tiempo de espera agotado (timeout)',
          summary: 'No verificado: timeout de conexión',
          verifiedAt: now,
          provenance: 'independent_http',
        };
      }

      if (
        code.startsWith('ERR_TLS') ||
        code.includes('CERT') ||
        code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        msg.toLowerCase().includes('certificate') ||
        msg.toLowerCase().includes('tls') ||
        msg.toLowerCase().includes('ssl')
      ) {
        return {
          checkedUrl: trimmed,
          finalUrl: safeTargetUrl,
          status: 'unverified_inconclusive',
          httpStatus: null,
          tlsValid: false,
          isSocialOnly: false,
          inconclusiveReason: `Error de certificado TLS (${code || 'TLS'})`,
          summary: 'No verificado: problema de certificado TLS/HTTPS (requiere revisión manual)',
          verifiedAt: now,
          provenance: 'independent_http',
        };
      }

      if (code === 'ENOTFOUND' || code === 'EAI_NONAME' || code === 'ECONNREFUSED') {
        return {
          checkedUrl: trimmed,
          finalUrl: safeTargetUrl,
          status: 'unreachable_verified',
          httpStatus: null,
          tlsValid: null,
          isSocialOnly: false,
          inconclusiveReason: null,
          summary: `Dominio o servidor inaccesible (${code})`,
          verifiedAt: now,
          provenance: 'independent_http',
        };
      }

      return {
        checkedUrl: trimmed,
        finalUrl: safeTargetUrl,
        status: 'unverified_inconclusive',
        httpStatus: null,
        tlsValid: null,
        isSocialOnly: false,
        inconclusiveReason: `Error de red inconcluso (${code || msg || 'desconocido'})`,
        summary: 'No verificado por error temporal de red',
        verifiedAt: now,
        provenance: 'independent_http',
      };
    }
  }

  return {
    checkedUrl: trimmed,
    finalUrl: null,
    status: 'unverified_inconclusive',
    httpStatus: null,
    tlsValid: null,
    isSocialOnly: false,
    inconclusiveReason: `Excedido límite de ${maxRedirects} redirecciones`,
    summary: 'No verificado: demasiadas redirecciones',
    verifiedAt: now,
    provenance: 'independent_http',
  };
}
