import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { DailyQuotaGuard } from './server/quotaGuard';
import { getPlaceDetailsById, PlacesApiError, searchPlacesNewApi } from './server/placesService';
import { verifyWebsiteIndependently } from './server/websiteVerifier';
import { GeminiSubzoneError, suggestPeruvianSubzones } from './server/geminiSubzoneService';
import { extractWebsiteMetadataSafe } from './server/websiteMetadataExtractor';
import { analyzeCandidatesWithGemini, GeminiAnalystError } from './server/geminiAnalystService';

function loadEnvFileIfPresent(filename: string) {
  const filePath = path.resolve(process.cwd(), filename);
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const rawVal = trimmed.slice(eqIndex + 1).trim();
    const val = rawVal.replace(/^["']|["']$/g, '');
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

loadEnvFileIfPresent('.env.local');
loadEnvFileIfPresent('.env');

const quotaGuard = new DailyQuotaGuard();

export function createApiApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    const keyPresence = {
      GOOGLE_MAPS_PLATFORM_KEY: Boolean(process.env.GOOGLE_MAPS_PLATFORM_KEY),
      GOOGLE_MAPS_API_KEY: Boolean(process.env.GOOGLE_MAPS_API_KEY),
      VITE_GOOGLE_MAPS_API_KEY: Boolean(process.env.VITE_GOOGLE_MAPS_API_KEY),
    };
    const hasMapsKey =
      keyPresence.GOOGLE_MAPS_PLATFORM_KEY ||
      keyPresence.GOOGLE_MAPS_API_KEY ||
      keyPresence.VITE_GOOGLE_MAPS_API_KEY;
    const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);
    res.json({
      ok: true,
      hasMapsKey,
      keyPresence,
      hasGeminiKey,
      quota: quotaGuard.getStatus(),
    });
  });

  app.get('/api/quota', (_req, res) => {
    res.json(quotaGuard.getStatus());
  });

  app.post('/api/places/search', async (req, res) => {
    try {
      const businessType = String(req.body?.businessType || '').trim();
      const location = String(req.body?.location || '').trim();
      const subzone = String(req.body?.subzone || '').trim();
      const pageToken = typeof req.body?.pageToken === 'string' && req.body.pageToken.trim()
        ? req.body.pageToken.trim()
        : undefined;

      if (!businessType || !location) {
        return res.status(400).json({
          code: 'INVALID_QUERY',
          message: 'Debes indicar tanto el tipo de negocio como la ubicación en Perú.',
        });
      }

      const baseLocation = /per[uú]\s*$/i.test(location) ? location : `${location}, Perú`;
      const fullLocation = subzone ? `${subzone}, ${baseLocation}` : baseLocation;
      const textQuery = `${businessType} en ${fullLocation}`;
      const cacheKey = `places:${textQuery.toLowerCase()}:${pageToken || 'first'}`;

      const cached = quotaGuard.getCached<{ places: unknown[]; nextPageToken: string | null }>(cacheKey);
      if (cached) {
        return res.json({
          ...cached,
          fromCache: true,
          queryUsed: textQuery,
          quota: quotaGuard.getStatus(),
        });
      }

      const hasMapsKey = Boolean(
        process.env.GOOGLE_MAPS_PLATFORM_KEY ||
          process.env.GOOGLE_MAPS_API_KEY ||
          process.env.VITE_GOOGLE_MAPS_API_KEY
      );
      if (!hasMapsKey) {
        return res.status(503).json({
          code: 'MAPS_KEY_MISSING',
          message:
            'La clave de Google Maps Platform no está configurada aún. Habilita Google Maps en la configuración de AI Studio.',
          quota: quotaGuard.getStatus(),
        });
      }

      if (!quotaGuard.canUsePlaces()) {
        return res.status(429).json({
          code: 'LOCAL_DAILY_QUOTA_REACHED',
          message:
            'Se alcanzó el límite diario preventivo de consultas a Places API (New) para proteger la cuota gratuita. Los resultados en caché siguen disponibles.',
          quota: quotaGuard.getStatus(),
        });
      }

      quotaGuard.consumePlaces();
      const result = await searchPlacesNewApi({ textQuery, pageToken, pageSize: 20 });

      quotaGuard.setCached(cacheKey, {
        places: result.places,
        nextPageToken: result.nextPageToken,
      });

      return res.json({
        places: result.places,
        nextPageToken: result.nextPageToken,
        fromCache: false,
        queryUsed: textQuery,
        quota: quotaGuard.getStatus(),
      });
    } catch (err: any) {
      if (err instanceof PlacesApiError) {
        return res.status(err.status).json({
          code: err.code,
          message: err.message,
          quota: quotaGuard.getStatus(),
        });
      }
      return res.status(500).json({
        code: 'PLACES_INTERNAL_ERROR',
        message: err?.message || 'Error inesperado consultando Places API (New).',
        quota: quotaGuard.getStatus(),
      });
    }
  });

  app.post('/api/verify-website', async (req, res) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    if (!rawUrl || rawUrl.length > 500) {
      return res.status(400).json({
        code: 'INVALID_URL_PARAM',
        message: 'URL ausente o excede longitud máxima.',
      });
    }

    const cacheKey = `webprobe:${rawUrl.trim().toLowerCase()}`;
    const cached = quotaGuard.getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const probe = await verifyWebsiteIndependently(rawUrl);
    quotaGuard.setCached(cacheKey, probe);
    return res.json(probe);
  });

  app.post('/api/subzones', async (req, res) => {
    try {
      const location = String(req.body?.location || '').trim();
      const businessType = String(req.body?.businessType || '').trim();
      if (!location || !businessType) {
        return res.status(400).json({
          code: 'INVALID_SUBZONE_QUERY',
          message: 'Ingresa rubro y ubicación antes de solicitar subzonas.',
        });
      }

      const cacheKey = `subzones:${businessType.toLowerCase()}:${location.toLowerCase()}`;
      const cached = quotaGuard.getCached(cacheKey);
      if (cached) {
        return res.json({
          ...(cached as object),
          fromCache: true,
          quota: quotaGuard.getStatus(),
        });
      }

      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({
          code: 'GEMINI_KEY_MISSING',
          message: 'GEMINI_API_KEY no está configurada en los secretos del servidor.',
          quota: quotaGuard.getStatus(),
        });
      }

      if (!quotaGuard.canUseGemini()) {
        return res.status(429).json({
          code: 'LOCAL_GEMINI_QUOTA_REACHED',
          message: 'Se alcanzó el límite diario preventivo para sugerencias de subzonas con Gemini.',
          quota: quotaGuard.getStatus(),
        });
      }

      quotaGuard.consumeGemini();
      const result = await suggestPeruvianSubzones(location, businessType);
      quotaGuard.setCached(cacheKey, result);
      return res.json({
        ...result,
        fromCache: false,
        quota: quotaGuard.getStatus(),
      });
    } catch (err: any) {
      if (err instanceof GeminiSubzoneError) {
        return res.status(err.status).json({
          code: err.code,
          message: err.message,
          quota: quotaGuard.getStatus(),
        });
      }
      return res.status(500).json({
        code: 'GEMINI_INTERNAL_ERROR',
        message: err?.message || 'Error inesperado al sugerir subzonas.',
        quota: quotaGuard.getStatus(),
      });
    }
  });

  app.post('/api/analyze-leads', async (req, res) => {
    try {
      const rawItems = Array.isArray(req.body?.candidates) ? req.body.candidates.slice(0, 8) : [];
      if (rawItems.length === 0) {
        return res.json({
          analyses: [],
          modelUsed: 'none',
          warning: null,
          quota: quotaGuard.getStatus(),
        });
      }

      if (!process.env.GEMINI_API_KEY) {
        return res.json({
          analyses: [],
          modelUsed: 'none',
          warning: 'GEMINI_API_KEY no configurada; se aplicó únicamente evaluación determinística.',
          quota: quotaGuard.getStatus(),
        });
      }

      if (!quotaGuard.canUseGemini()) {
        return res.status(429).json({
          code: 'LOCAL_GEMINI_QUOTA_REACHED',
          message: 'Cuota diaria preventiva de Gemini alcanzada; continúa usando la evaluación determinística.',
          quota: quotaGuard.getStatus(),
        });
      }

      // Extrae metadatos HTML públicos (con protección SSRF y sin PII) solo de webs oficiales válidas
      const prepared = await Promise.all(
        rawItems.map(async (item: any) => {
          const placeId = String(item?.placeId || '').trim();
          const category = String(item?.category || 'Comercio').trim();
          const websiteStatus = item?.websiteStatus || 'unregistered';
          const userNotes = String(item?.userNotes || '').trim();
          const officialWebsiteUrl =
            typeof item?.officialWebsiteUrl === 'string' ? item.officialWebsiteUrl.trim() : '';

          let websiteMeta = null;
          if (
            officialWebsiteUrl &&
            (websiteStatus === 'active_https' ||
              websiteStatus === 'active_http' ||
              websiteStatus === 'unverified_inconclusive')
          ) {
            const metaCacheKey = `webmeta:${officialWebsiteUrl.toLowerCase()}`;
            websiteMeta = quotaGuard.getCached<any>(metaCacheKey);
            if (!websiteMeta) {
              websiteMeta = await extractWebsiteMetadataSafe(officialWebsiteUrl);
              quotaGuard.setCached(metaCacheKey, websiteMeta);
            }
          }

          return {
            placeId,
            category,
            websiteStatus,
            userNotes,
            websiteMeta,
          };
        })
      );

      quotaGuard.consumeGemini();
      const result = await analyzeCandidatesWithGemini(prepared);

      return res.json({
        analyses: result.analyses,
        modelUsed: result.modelUsed,
        warning: null,
        quota: quotaGuard.getStatus(),
      });
    } catch (err: any) {
      if (err instanceof GeminiAnalystError) {
        return res.status(err.status).json({
          code: err.code,
          message: err.message,
          analyses: [],
          quota: quotaGuard.getStatus(),
        });
      }
      return res.status(500).json({
        code: 'GEMINI_ANALYST_INTERNAL',
        message: err?.message || 'Error inesperado analizando candidatos con Gemini.',
        analyses: [],
        quota: quotaGuard.getStatus(),
      });
    }
  });

  app.post('/api/places/details', async (req, res) => {
    try {
      const rawIds: unknown[] = Array.isArray(req.body?.placeIds) ? req.body.placeIds : [];
      const uniqueIds: string[] = Array.from(
        new Set(
          rawIds
            .filter((id): id is string => typeof id === 'string')
            .map((id) => id.trim())
            .filter((id) => /^[a-zA-Z0-9_-]+$/.test(id) && !id.startsWith('manual_'))
        )
      ).slice(0, 10);

      if (uniqueIds.length === 0) {
        return res.json({ details: {}, quota: quotaGuard.getStatus() });
      }

      const details: Record<string, unknown> = {};
      for (const placeId of uniqueIds) {
        const cacheKey = `placedetails:${placeId}`;
        const cached = quotaGuard.getCached(cacheKey);
        if (cached) {
          details[placeId] = cached;
          continue;
        }
        if (!quotaGuard.canUsePlaces()) {
          break;
        }
        quotaGuard.consumePlaces();
        const fetched = await getPlaceDetailsById(placeId);
        if (fetched) {
          quotaGuard.setCached(cacheKey, fetched);
          details[placeId] = fetched;
        }
      }

      return res.json({ details, quota: quotaGuard.getStatus() });
    } catch (err: any) {
      if (err instanceof PlacesApiError) {
        return res.status(err.status).json({
          code: err.code,
          message: err.message,
          quota: quotaGuard.getStatus(),
        });
      }
      return res.status(500).json({
        code: 'PLACE_DETAILS_INTERNAL_ERROR',
        message: err?.message || 'Error al hidratar detalles desde Places API.',
        quota: quotaGuard.getStatus(),
      });
    }
  });

  return app;
}

async function startServer() {
  const app = createApiApp();
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`WEBNEX Opportunity Engine server running on http://0.0.0.0:${port}`);
  });
}

if (process.env.VITEST !== 'true') {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
