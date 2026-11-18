import { validateAndResolveSafeUrl } from './ssrfGuard';

export interface SafeWebsiteMetadata {
  urlChecked: string;
  isHttps: boolean;
  httpStatus: number | null;
  title: string | null;
  metaDescription: string | null;
  headings: string[];
  hasViewportMeta: boolean;
  cmsHint: string | null;
  extractionStatus: 'ok' | 'blocked_or_unavailable';
}

function stripTagsAndPii(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    // Strip email addresses and phone-like sequences so Gemini never receives contact PII
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email]')
    .replace(/(?:\+?\d[\d\s\-()]{6,}\d)/g, '[tel]')
    .trim();
}

function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

export function extractHtmlSignals(html: string, urlChecked: string, httpStatus: number): SafeWebsiteMetadata {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeBasicHtmlEntities(stripTagsAndPii(titleMatch[1])).slice(0, 140) : null;

  const descMatch =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i);
  const metaDescription = descMatch
    ? decodeBasicHtmlEntities(stripTagsAndPii(descMatch[1])).slice(0, 240)
    : null;

  const headings: string[] = [];
  const hRegex = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi;
  let match: RegExpExecArray | null;
  while ((match = hRegex.exec(html)) !== null && headings.length < 4) {
    const clean = decodeBasicHtmlEntities(stripTagsAndPii(match[1])).slice(0, 100);
    if (clean.length >= 3 && !headings.includes(clean)) {
      headings.push(clean);
    }
  }

  const hasViewportMeta = /<meta[^>]+name=["']viewport["']/i.test(html);

  let cmsHint: string | null = null;
  if (/wp-content|wp-includes|WordPress/i.test(html)) cmsHint = 'WordPress';
  else if (/wixstatic\.com|Wix\.com/i.test(html)) cmsHint = 'Wix';
  else if (/cdn\.shopify\.com|Shopify/i.test(html)) cmsHint = 'Shopify';
  else if (/squarespace\.com/i.test(html)) cmsHint = 'Squarespace';
  else if (/blogspot\.com|blogger\.com/i.test(html)) cmsHint = 'Blogger';

  return {
    urlChecked,
    isHttps: urlChecked.toLowerCase().startsWith('https://'),
    httpStatus,
    title: title || null,
    metaDescription: metaDescription || null,
    headings,
    hasViewportMeta,
    cmsHint,
    extractionStatus: 'ok',
  };
}

/**
 * Descarga de forma segura (con protección SSRF y límite de bytes) únicamente señales técnicas
 * públicas del sitio web oficial de un negocio para evaluación técnica con Gemini.
 */
export async function extractWebsiteMetadataSafe(
  rawUrl: string,
  options?: {
    fetchFn?: typeof fetch;
    dnsLookupFn?: Parameters<typeof validateAndResolveSafeUrl>[1];
  }
): Promise<SafeWebsiteMetadata> {
  const fetchFn = options?.fetchFn || fetch;
  const fallback: SafeWebsiteMetadata = {
    urlChecked: rawUrl,
    isHttps: rawUrl.toLowerCase().startsWith('https://'),
    httpStatus: null,
    title: null,
    metaDescription: null,
    headings: [],
    hasViewportMeta: false,
    cmsHint: null,
    extractionStatus: 'blocked_or_unavailable',
  };

  let currentUrl = rawUrl.trim();
  for (let hop = 0; hop <= 2; hop++) {
    const safeCheck = await validateAndResolveSafeUrl(currentUrl, options?.dnsLookupFn);
    if (!safeCheck.ok) {
      return fallback;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetchFn(safeCheck.parsedUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'WEBNEX-TechCheck/1.0 (+https://webnexsystems.pe)',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return fallback;
        currentUrl = new URL(location, safeCheck.parsedUrl).toString();
        continue;
      }

      if (res.status >= 400) {
        return { ...fallback, httpStatus: res.status };
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return { ...fallback, httpStatus: res.status };
      }

      const rawText = (await res.text()).slice(0, 65536);
      return extractHtmlSignals(rawText, safeCheck.parsedUrl.toString(), res.status);
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  return fallback;
}
