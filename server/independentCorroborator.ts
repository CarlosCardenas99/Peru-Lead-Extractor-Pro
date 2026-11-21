import {
  CorroboratedFieldCandidate,
  IndependentCorroborationResult,
  PhoneLineType,
  WebsiteVerificationStatus,
} from '../types';
import { analyzePeruvianPhone } from '../utils/peruPhone';
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
  'maps.google.com',
  'google.com',
];

export const PERU_DISTRICTS = [
  'San Juan de Lurigancho',
  'San Juan de Miraflores',
  'San Martín de Porres',
  'San Martin de Porres',
  'Villa El Salvador',
  'Villa María del Triunfo',
  'Villa Maria del Triunfo',
  'Magdalena del Mar',
  'Santiago de Surco',
  'Cercado de Lima',
  'Los Olivos',
  'Independencia',
  'Comas',
  'Carabayllo',
  'Puente Piedra',
  'Ancón',
  'Santa Rosa',
  'Miraflores',
  'San Isidro',
  'Surco',
  'San Borja',
  'La Molina',
  'Jesús María',
  'Jesus Maria',
  'Lince',
  'Magdalena',
  'Pueblo Libre',
  'San Miguel',
  'Chorrillos',
  'Barranco',
  'Surquillo',
  'Ate',
  'Santa Anita',
  'La Victoria',
  'San Luis',
  'Breña',
  'Rímac',
  'El Agustino',
  'Lurigancho',
  'Chaclacayo',
  'Lurín',
  'Pachacamac',
  'Bellavista',
  'La Perla',
  'Ventanilla',
  'Carmen de la Legua',
  'Arequipa',
  'Trujillo',
  'Chiclayo',
  'Piura',
  'Cusco',
  'Huancayo',
  'Ica',
  'Tacna',
  'Callao',
  'Lima',
];

function isSocialOrGoogleHost(hostname: string): boolean {
  const h = hostname.replace(/^www\./, '').toLowerCase();
  return SOCIAL_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&aacute;/gi, 'á')
    .replace(/&eacute;/gi, 'é')
    .replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó')
    .replace(/&uacute;/gi, 'ú')
    .replace(/&ntilde;/gi, 'ñ')
    .replace(/&Aacute;/gi, 'Á')
    .replace(/&Eacute;/gi, 'É')
    .replace(/&Iacute;/gi, 'Í')
    .replace(/&Oacute;/gi, 'Ó')
    .replace(/&Uacute;/gi, 'Ú')
    .replace(/&Ntilde;/gi, 'Ñ');
}

export function stripTags(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

function cleanBusinessTitle(rawTitle: string): string {
  const cleaned = rawTitle
    .split(/\s+[|\-–—·]\s+/)[0]
    .replace(/^(inicio|home|bienvenidos a|welcome to)\s+/i, '')
    .trim();
  if (cleaned.length < 2 || /^(inicio|home|index|untitled|404|403|error)$/i.test(cleaned)) {
    return '';
  }
  return cleaned.slice(0, 160);
}

export function extractFirstValidEmail(html: string): string | null {
  const mailtoMatches = Array.from(html.matchAll(/href=["']mailto:([^"'?#\s]+)["']/gi)).map((m) =>
    m[1].trim()
  );
  const textEmails = Array.from(
    stripTags(html).matchAll(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g)
  ).map((m) => m[1].trim());

  const ignoredDomains = [
    'example.com',
    'sentry.io',
    'wixpress.com',
    'wordpress.org',
    'schema.org',
    'googleapis.com',
    'w3.org',
  ];

  for (const raw of [...mailtoMatches, ...textEmails]) {
    const lower = raw.toLowerCase();
    if (lower.length > 160) continue;
    if (/\.(png|jpg|jpeg|svg|webp|gif|css|js)$/i.test(lower)) continue;
    if (ignoredDomains.some((d) => lower.endsWith(`@${d}`) || lower.includes(`.${d}`))) continue;
    return lower;
  }
  return null;
}

function isLikelyDummyPhone(e164: string): boolean {
  const digits = e164.replace(/\D/g, '');
  const local = digits.startsWith('51') ? digits.slice(2) : digits;
  if (!local) return true;
  if (/^(\d)\1+$/.test(local)) return true; // 999999999, 000000000
  if (local === '123456789' || local === '012345678') return true;
  if (/^(\d\d)\1{3,}\d?$/.test(local)) return true; // e.g. 979797979
  return false;
}

export interface ExtractedPeruvianPhoneItem {
  formatted: string;
  e164: string;
  lineType: PhoneLineType;
}

export function extractPeruvianPhonesFromHtml(html: string): ExtractedPeruvianPhoneItem[] {
  const telMatches = Array.from(html.matchAll(/href=["']tel:([^"']+)["']/gi)).map((m) =>
    decodeURIComponent(m[1]).trim()
  );
  const waShortMatches = Array.from(
    html.matchAll(/https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\?[^"'\s]*?phone=)\/?(\+?51\d{9}|\d{9})/gi)
  ).map((m) => m[1].trim());
  const textMatches = Array.from(
    stripTags(html).matchAll(
      /(?:\+?51[\s\-]*)?(?:\(0?\d{1,2}\)[\s\-]*)?(?:9\d{2}[\s\-]*\d{3}[\s\-]*\d{3}|\b0?\d{2}[\s\-]*\d{6,7}\b)/g
    )
  ).map((m) => m[0].trim());

  const mobiles: ExtractedPeruvianPhoneItem[] = [];
  const landlines: ExtractedPeruvianPhoneItem[] = [];
  const seenE164 = new Set<string>();

  for (const candidate of [...telMatches, ...waShortMatches, ...textMatches]) {
    const parsed = analyzePeruvianPhone(candidate);
    if (!parsed.isValidFormat || !parsed.e164 || !parsed.formatted) continue;
    if (isLikelyDummyPhone(parsed.e164)) continue;
    if (seenE164.has(parsed.e164)) continue;
    seenE164.add(parsed.e164);

    const item: ExtractedPeruvianPhoneItem = {
      formatted: parsed.formatted,
      e164: parsed.e164,
      lineType: parsed.lineType,
    };
    if (parsed.lineType === 'mobile') {
      mobiles.push(item);
    } else {
      landlines.push(item);
    }
  }

  return [...mobiles, ...landlines];
}

function extractFirstPeruvianPhone(
  html: string
): { formatted: string; lineType: PhoneLineType } | null {
  const all = extractPeruvianPhonesFromHtml(html);
  return all[0] ? { formatted: all[0].formatted, lineType: all[0].lineType } : null;
}

export function extractSocialLinksFromHtml(html: string): string[] {
  const rawLinks = Array.from(
    html.matchAll(/href=["'](https?:\/\/(?:www\.|m\.|web\.)?(?:facebook|fb|instagram)\.com\/[^"'#\s]+)["']/gi)
  ).map((m) => decodeHtmlEntities(m[1].trim()));

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const link of rawLinks) {
    try {
      const u = new URL(link);
      const pathLower = u.pathname.toLowerCase();
      if (
        !pathLower ||
        pathLower === '/' ||
        /\/(sharer|share|plugins|tr|login|accounts|policies|privacy|help|reel|p)\b/.test(pathLower) ||
        pathLower.endsWith('.php')
      ) {
        continue;
      }
      u.search = '';
      const clean = u.toString().replace(/\/+$/, '');
      if (!seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        unique.push(clean);
      }
    } catch {
      continue;
    }
  }
  return unique.slice(0, 4);
}

export function detectDistrictInText(text: string): string | null {
  const normalizedText = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  for (const district of PERU_DISTRICTS) {
    const normalizedDistrict = district
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const escaped = normalizedDistrict.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`);
    if (regex.test(normalizedText)) {
      return district;
    }
  }
  return null;
}

export function extractStreetAddressFromText(text: string): string | null {
  const match = text.match(
    /\b(?:Av\.?|Avenida|Jr\.?|Jirón|Jiron|Calle|Ca\.?|Pasaje|Psj\.?|Mz\.?|Manzana|Urb\.?|Urbanización)\s+[A-Za-zÁÉÍÓÚÑáéíóúñ0-9°º.,\-\s]{6,110}/i
  );
  if (!match) return null;
  const cleaned = match[0].replace(/\s+/g, ' ').trim().slice(0, 180);
  return cleaned.length >= 10 ? cleaned : null;
}

interface ParsedJsonLdBusiness {
  name?: string;
  telephone?: string;
  email?: string;
  address?: string;
  district?: string;
  category?: string;
}

function flattenJsonLdNodes(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLdNodes(item, out);
    return out;
  }
  out.push(node);
  if (Array.isArray(node['@graph'])) {
    flattenJsonLdNodes(node['@graph'], out);
  }
  return out;
}

function parseJsonLdBusinessSignals(html: string): ParsedJsonLdBusiness {
  const result: ParsedJsonLdBusiness = {};
  const blocks = Array.from(
    html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  );

  for (const match of blocks) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const nodes = flattenJsonLdNodes(parsed);
      for (const node of nodes) {
        const rawType = Array.isArray(node['@type']) ? node['@type'][0] : node['@type'];
        const typeStr = typeof rawType === 'string' ? rawType : '';
        if (
          /^(WebSite|WebPage|BreadcrumbList|SearchAction|ImageObject|ListItem)$/i.test(typeStr)
        ) {
          continue;
        }
        if (!result.name && typeof node.name === 'string' && node.name.trim()) {
          result.name = node.name.trim().slice(0, 160);
        }
        if (!result.telephone && typeof node.telephone === 'string' && node.telephone.trim()) {
          result.telephone = node.telephone.trim();
        }
        if (!result.email && typeof node.email === 'string' && node.email.trim()) {
          result.email = node.email.replace(/^mailto:/i, '').trim().toLowerCase().slice(0, 160);
        }
        if (
          !result.category &&
          typeStr &&
          !/^(Organization|LocalBusiness|Place|Thing)$/i.test(typeStr)
        ) {
          result.category = typeStr.replace(/([a-z])([A-Z])/g, '$1 $2').slice(0, 120);
        }
        const addr = node.address;
        if (addr && typeof addr === 'object') {
          const street = typeof addr.streetAddress === 'string' ? addr.streetAddress.trim() : '';
          const locality =
            typeof addr.addressLocality === 'string' ? addr.addressLocality.trim() : '';
          const region = typeof addr.addressRegion === 'string' ? addr.addressRegion.trim() : '';
          const combined = [street, locality, region].filter(Boolean).join(', ');
          if (!result.address && combined) {
            result.address = combined.slice(0, 200);
          }
          if (!result.district && locality) {
            result.district = locality.slice(0, 120);
          }
        } else if (!result.address && typeof addr === 'string' && addr.trim()) {
          result.address = addr.trim().slice(0, 200);
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }

  return result;
}

export function extractIndependentSignalsFromHtml(
  html: string,
  sourceUrl: string,
  verifiedAt: string
): IndependentCorroborationResult['candidates'] {
  const jsonLd = parseJsonLdBusinessSignals(html);

  const ogSiteNameMatch =
    html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["'][^>]*>/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:site_name["'][^>]*>/i);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  const rawHtmlName =
    (ogSiteNameMatch ? decodeHtmlEntities(ogSiteNameMatch[1]).trim() : '') ||
    (titleMatch ? cleanBusinessTitle(stripTags(titleMatch[1])) : '');

  const businessName: CorroboratedFieldCandidate<string> | null = jsonLd.name
    ? {
        value: jsonLd.name,
        source: 'official_website_jsonld',
        evidenceUrl: sourceUrl,
        verifiedAt,
        confidence: 'high',
      }
    : rawHtmlName
    ? {
        value: rawHtmlName.slice(0, 160),
        source: 'official_website_html',
        evidenceUrl: sourceUrl,
        verifiedAt,
        confidence: 'medium',
      }
    : null;

  let phoneCandidate: CorroboratedFieldCandidate<string> | null = null;
  let phoneTypeCandidate: CorroboratedFieldCandidate<PhoneLineType> | null = null;
  if (jsonLd.telephone) {
    const parsed = analyzePeruvianPhone(jsonLd.telephone);
    if (parsed.isValidFormat) {
      phoneCandidate = {
        value: parsed.formatted,
        source: 'official_website_jsonld',
        evidenceUrl: sourceUrl,
        verifiedAt,
        confidence: 'high',
      };
      phoneTypeCandidate = {
        value: parsed.lineType,
        source: 'official_website_jsonld',
        evidenceUrl: sourceUrl,
        verifiedAt,
        confidence: 'high',
      };
    }
  }
  if (!phoneCandidate) {
    const htmlPhone = extractFirstPeruvianPhone(html);
    if (htmlPhone) {
      phoneCandidate = {
        value: htmlPhone.formatted,
        source: 'official_website_html',
        evidenceUrl: sourceUrl,
        verifiedAt,
        confidence: 'medium',
      };
      phoneTypeCandidate = {
        value: htmlPhone.lineType,
        source: 'official_website_html',
        evidenceUrl: sourceUrl,
        verifiedAt,
        confidence: 'medium',
      };
    }
  }

  const emailValue = jsonLd.email || extractFirstValidEmail(html);
  const emailCandidate: CorroboratedFieldCandidate<string> | null = emailValue
    ? {
        value: emailValue,
        source: jsonLd.email ? 'official_website_jsonld' : 'official_website_html',
        evidenceUrl: sourceUrl,
        verifiedAt,
        confidence: jsonLd.email ? 'high' : 'medium',
      }
    : null;

  const plainText = stripTags(html);
  const detectedAddress = jsonLd.address || extractStreetAddressFromText(plainText);
  const addressCandidate: CorroboratedFieldCandidate<string> | null = detectedAddress
    ? {
        value: detectedAddress,
        source: jsonLd.address ? 'official_website_jsonld' : 'official_website_html',
        evidenceUrl: sourceUrl,
        verifiedAt,
        confidence: jsonLd.address ? 'high' : 'medium',
      }
    : null;

  const detectedDistrict =
    jsonLd.district || detectDistrictInText(detectedAddress || '') || detectDistrictInText(plainText);
  const districtCandidate: CorroboratedFieldCandidate<string> | null = detectedDistrict
    ? {
        value: detectedDistrict,
        source: jsonLd.district ? 'official_website_jsonld' : 'official_website_html',
        evidenceUrl: sourceUrl,
        verifiedAt,
        confidence: jsonLd.district ? 'high' : 'medium',
      }
    : null;

  const categoryCandidate: CorroboratedFieldCandidate<string> | null = jsonLd.category
    ? {
        value: jsonLd.category,
        source: 'official_website_jsonld',
        evidenceUrl: sourceUrl,
        verifiedAt,
        confidence: 'high',
      }
    : null;

  return {
    businessName,
    phone: phoneCandidate,
    phoneType: phoneTypeCandidate,
    address: addressCandidate,
    district: districtCandidate,
    website: {
      value: sourceUrl,
      source: 'official_website_html',
      evidenceUrl: sourceUrl,
      verifiedAt,
      confidence: 'high',
    },
    email: emailCandidate,
    category: categoryCandidate,
  };
}

function findSameOriginContactUrl(html: string, baseUrl: string): string | null {
  const base = new URL(baseUrl);
  const linkMatches = Array.from(html.matchAll(/href=["']([^"'#]+)["']/gi));
  for (const m of linkMatches) {
    const href = m[1].trim();
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    try {
      const resolved = new URL(href, base);
      if (resolved.origin !== base.origin) continue;
      if (/\/(contacto|contactanos|contact|nosotros|about|ubicacion|aviso-legal)\b/i.test(resolved.pathname)) {
        return resolved.toString();
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function extractSafeWebsiteUrlFromNotes(text: string): string | null {
  const matches = Array.from(text.matchAll(/https?:\/\/[^\s<>"')]+/gi)).map((m) => m[0]);
  for (const raw of matches) {
    try {
      const u = new URL(raw);
      if (!isSocialOrGoogleHost(u.hostname)) {
        return u.toString();
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchHtmlSafely(
  rawUrl: string,
  fetchFn: typeof fetch,
  dnsLookupFn?: DnsLookupFn
): Promise<{ ok: true; url: string; html: string; status: number } | { ok: false; status: WebsiteVerificationStatus; reason: string }> {
  let currentUrl = rawUrl.trim();
  for (let hop = 0; hop <= 2; hop++) {
    const validation = await validateAndResolveSafeUrl(currentUrl, dnsLookupFn);
    if (validation.ok === false) {
      return {
        ok: false,
        status:
          validation.code === 'INVALID_URL'
            ? 'invalid_url'
            : validation.code === 'DNS_NOT_FOUND'
            ? 'unreachable_verified'
            : 'unverified_inconclusive',
        reason: validation.reason,
      };
    }
    const targetUrl = validation.parsedUrl.toString();
    if (isSocialOrGoogleHost(validation.parsedUrl.hostname)) {
      return {
        ok: false,
        status: 'social_only',
        reason: `URL corresponde a red social o plataforma externa (${validation.parsedUrl.hostname}).`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetchFn(targetUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'WEBNEX-IndependentVerifier/1.0',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          return {
            ok: false,
            status: 'unverified_inconclusive',
            reason: `Redirección HTTP ${res.status} sin cabecera Location.`,
          };
        }
        currentUrl = new URL(location, targetUrl).toString();
        continue;
      }

      if (res.status === 404 || res.status === 410) {
        return {
          ok: false,
          status: 'unreachable_verified',
          reason: `Sitio respondió HTTP ${res.status}.`,
        };
      }

      if (res.status === 403 || res.status === 405 || res.status === 429 || res.status >= 500) {
        return {
          ok: false,
          status: 'unverified_inconclusive',
          reason: `Bloqueo o error temporal HTTP ${res.status} (clasificado como no verificado).`,
        };
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return {
          ok: false,
          status: 'unverified_inconclusive',
          reason: 'El recurso no devolvió HTML público legible.',
        };
      }

      const html = (await res.text()).slice(0, 131072);
      return { ok: true, url: targetUrl, html, status: res.status };
    } catch {
      return {
        ok: false,
        status: 'unverified_inconclusive',
        reason: 'Timeout o error de red al leer el sitio web oficial.',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    status: 'unverified_inconclusive',
    reason: 'Demasiadas redirecciones al comprobar la URL oficial.',
  };
}

/**
 * Corrobora campos comerciales desde fuentes independientes permitidas (sitio web oficial del negocio
 * y contexto propio de búsqueda/notas del usuario). NUNCA consulta Google Places API ni copia
 * campos restringidos de Google Maps.
 */
export interface CorroborationDetailedResult extends IndependentCorroborationResult {
  allFoundPhones: Array<ExtractedPeruvianPhoneItem & { evidenceUrl: string }>;
  discoveredSocialLinks: string[];
}

export async function corroborateLeadIndependently(
  input: {
    placeId: string;
    officialWebsiteUrl?: string | null;
    notesText?: string;
    searchCategory?: string;
    searchDistrict?: string;
  },
  deps?: {
    fetchFn?: typeof fetch;
    dnsLookupFn?: DnsLookupFn;
  }
): Promise<CorroborationDetailedResult> {
  const verifiedAt = new Date().toISOString();
  const fetchFn = deps?.fetchFn || fetch;
  const candidateUrl =
    (input.officialWebsiteUrl || '').trim() ||
    extractSafeWebsiteUrlFromNotes(input.notesText || '') ||
    '';

  const candidates: IndependentCorroborationResult['candidates'] = {
    businessName: null,
    phone: null,
    phoneType: null,
    address: null,
    district: null,
    website: null,
    email: null,
    category: null,
  };
  const checkedUrls: string[] = [];
  const allFoundPhones: Array<ExtractedPeruvianPhoneItem & { evidenceUrl: string }> = [];
  const seenPhoneE164 = new Set<string>();
  const discoveredSocialLinks: string[] = [];
  const seenSocial = new Set<string>();

  const appendPhones = (html: string, evidenceUrl: string) => {
    for (const item of extractPeruvianPhonesFromHtml(html)) {
      if (seenPhoneE164.has(item.e164)) continue;
      seenPhoneE164.add(item.e164);
      allFoundPhones.push({ ...item, evidenceUrl });
    }
    for (const s of extractSocialLinksFromHtml(html)) {
      if (!seenSocial.has(s.toLowerCase())) {
        seenSocial.add(s.toLowerCase());
        discoveredSocialLinks.push(s);
      }
    }
  };

  let websiteStatus: WebsiteVerificationStatus = 'unregistered';
  let summary = 'Sin sitio web oficial propio para corroboración automática; requiere captura legítima del usuario.';

  if (candidateUrl) {
    const homeFetch = await fetchHtmlSafely(candidateUrl, fetchFn, deps?.dnsLookupFn);
    if (homeFetch.ok === true) {
      checkedUrls.push(homeFetch.url);
      websiteStatus = homeFetch.url.startsWith('https://') ? 'active_https' : 'active_http';
      const homeSignals = extractIndependentSignalsFromHtml(homeFetch.html, homeFetch.url, verifiedAt);
      Object.assign(candidates, homeSignals);
      appendPhones(homeFetch.html, homeFetch.url);
      if (homeSignals.phone?.value) {
        const p = analyzePeruvianPhone(homeSignals.phone.value);
        if (p.isValidFormat && p.e164 && !seenPhoneE164.has(p.e164)) {
          seenPhoneE164.add(p.e164);
          allFoundPhones.unshift({
            formatted: p.formatted || homeSignals.phone.value,
            e164: p.e164,
            lineType: p.lineType,
            evidenceUrl: homeFetch.url,
          });
        }
      }

      // Si faltan teléfono, correo o dirección, intentar 1 página de contacto del mismo origen
      if (!candidates.phone || !candidates.email || !candidates.address) {
        const contactUrl = findSameOriginContactUrl(homeFetch.html, homeFetch.url);
        if (contactUrl && contactUrl !== homeFetch.url) {
          const contactFetch = await fetchHtmlSafely(contactUrl, fetchFn, deps?.dnsLookupFn);
          if (contactFetch.ok === true) {
            checkedUrls.push(contactFetch.url);
            const contactSignals = extractIndependentSignalsFromHtml(
              contactFetch.html,
              contactFetch.url,
              verifiedAt
            );
            appendPhones(contactFetch.html, contactFetch.url);
            candidates.businessName = candidates.businessName || contactSignals.businessName;
            candidates.phone = candidates.phone || contactSignals.phone;
            candidates.phoneType = candidates.phoneType || contactSignals.phoneType;
            candidates.address = candidates.address || contactSignals.address;
            candidates.district = candidates.district || contactSignals.district;
            candidates.email = candidates.email || contactSignals.email;
            candidates.category = candidates.category || contactSignals.category;
          }
        }
      }

      const foundList = [
        candidates.businessName ? 'nombre' : null,
        candidates.phone ? 'teléfono' : null,
        candidates.address ? 'dirección' : null,
        candidates.email ? 'correo' : null,
      ].filter(Boolean);

      summary =
        foundList.length > 0
          ? `Corroborado desde sitio web oficial (${checkedUrls[0]}): ${foundList.join(', ')}.`
          : `Sitio web oficial accesible (${checkedUrls[0]}), pero sin etiquetas públicas de contacto detectables.`;
    } else if (homeFetch.ok === false) {
      websiteStatus = homeFetch.status;
      summary = homeFetch.reason;
    }
  }

  // Fallback legítimo para categoría/distrito usando ÚNICAMENTE la consulta propia del usuario (nunca campos Maps)
  if (!candidates.category && input.searchCategory?.trim()) {
    candidates.category = {
      value: input.searchCategory.trim().slice(0, 120),
      source: 'user_search_context',
      evidenceUrl: null,
      verifiedAt,
      confidence: 'medium',
    };
  }
  if (!candidates.district && input.searchDistrict?.trim()) {
    candidates.district = {
      value: input.searchDistrict.trim().replace(/,?\s*per[uú]$/i, '').slice(0, 120),
      source: 'user_search_context',
      evidenceUrl: null,
      verifiedAt,
      confidence: 'medium',
    };
  }

  const coreCount = [
    Boolean(candidates.businessName),
    Boolean(candidates.phone),
    Boolean(candidates.address || candidates.district),
    Boolean(candidates.website),
  ].filter(Boolean).length;

  const completeness: IndependentCorroborationResult['completeness'] =
    coreCount >= 4 ? 'complete' : coreCount >= 1 ? 'partial' : 'insufficient';

  return {
    placeId: input.placeId,
    checkedUrls,
    websiteStatus,
    completeness,
    summary,
    candidates,
    allFoundPhones,
    discoveredSocialLinks,
  };
}
