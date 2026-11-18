import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { GeminiComplementaryAnalysis, WebsiteVerificationStatus } from '../types';
import { SafeWebsiteMetadata } from './websiteMetadataExtractor';

export interface GeminiAnalystCandidateInput {
  placeId: string;
  category: string;
  websiteStatus: WebsiteVerificationStatus;
  userNotes: string;
  websiteMeta: SafeWebsiteMetadata | null;
}

export class GeminiAnalystError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'GeminiAnalystError';
    this.status = status;
    this.code = code;
  }
}

export function sanitizeAnalystInput(candidate: GeminiAnalystCandidateInput): GeminiAnalystCandidateInput {
  // Garantiza cumplimiento ToS: solo rubro general, estado técnico verificado, metadatos HTML sin PII y notas propias del usuario.
  return {
    placeId: String(candidate.placeId || '').trim().slice(0, 160),
    category: String(candidate.category || 'Comercio').trim().slice(0, 80),
    websiteStatus: candidate.websiteStatus,
    userNotes: String(candidate.userNotes || '').trim().slice(0, 400),
    websiteMeta: candidate.websiteMeta
      ? {
          urlChecked: candidate.websiteMeta.urlChecked.slice(0, 200),
          isHttps: Boolean(candidate.websiteMeta.isHttps),
          httpStatus: candidate.websiteMeta.httpStatus,
          title: candidate.websiteMeta.title ? candidate.websiteMeta.title.slice(0, 140) : null,
          metaDescription: candidate.websiteMeta.metaDescription
            ? candidate.websiteMeta.metaDescription.slice(0, 240)
            : null,
          headings: Array.isArray(candidate.websiteMeta.headings)
            ? candidate.websiteMeta.headings.slice(0, 4).map((h) => String(h).slice(0, 100))
            : [],
          hasViewportMeta: Boolean(candidate.websiteMeta.hasViewportMeta),
          cmsHint: candidate.websiteMeta.cmsHint ? candidate.websiteMeta.cmsHint.slice(0, 40) : null,
          extractionStatus: candidate.websiteMeta.extractionStatus,
        }
      : null,
  };
}

export function parseGeminiAnalystResponse(
  rawText: string | undefined,
  allowedPlaceIds: Set<string>
): GeminiComplementaryAnalysis[] {
  const cleaned = (rawText || '').trim();
  if (!cleaned) {
    throw new GeminiAnalystError('Gemini devolvió respuesta vacía en el análisis.', 502, 'GEMINI_EMPTY_RESPONSE');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new GeminiAnalystError('Respuesta de Gemini sin JSON válido.', 502, 'GEMINI_INVALID_JSON');
    }
    parsed = JSON.parse(match[0]);
  }

  const rawItems: unknown[] = Array.isArray(parsed?.analyses) ? parsed.analyses : [];
  const results: GeminiComplementaryAnalysis[] = [];

  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as any;
    const placeId = typeof obj.placeId === 'string' ? obj.placeId.trim() : '';
    if (!placeId || !allowedPlaceIds.has(placeId)) continue;

    const toStringArray = (val: unknown, max: number) =>
      Array.isArray(val)
        ? val
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.trim())
            .filter(Boolean)
            .slice(0, max)
        : [];

    results.push({
      placeId,
      digitalNeeds: toStringArray(obj.digitalNeeds, 4),
      recommendedWebnexServices: toStringArray(obj.recommendedWebnexServices, 4),
      commercialRelevance:
        typeof obj.commercialRelevance === 'string'
          ? obj.commercialRelevance.trim().slice(0, 280)
          : 'Relevancia sujeta a verificación manual.',
      missingInformation: toStringArray(obj.missingInformation, 4),
      manualVerificationSteps: toStringArray(obj.manualVerificationSteps, 4),
      analyzedSourceNote:
        typeof obj.analyzedSourceNote === 'string'
          ? obj.analyzedSourceNote.trim().slice(0, 140)
          : 'Evaluación sobre estado técnico web / notas independientes',
    });
  }

  return results;
}

/**
 * Analiza únicamente señales permitidas e independientes (HTML público del sitio oficial del negocio,
 * estado técnico de verificación HTTP y notas propias del usuario). NUNCA recibe contenido restringido de Google Maps.
 */
export async function analyzeCandidatesWithGemini(
  candidatesInput: GeminiAnalystCandidateInput[]
): Promise<{ analyses: GeminiComplementaryAnalysis[]; modelUsed: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiAnalystError(
      'GEMINI_API_KEY no está configurada.',
      503,
      'GEMINI_KEY_MISSING'
    );
  }

  const safeCandidates = candidatesInput
    .slice(0, 8)
    .map(sanitizeAnalystInput)
    .filter((c) => c.placeId.length > 0);

  if (safeCandidates.length === 0) {
    return { analyses: [], modelUsed: 'none' };
  }

  const allowedPlaceIds = new Set(safeCandidates.map((c) => c.placeId));
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const prompt = `Evalúa técnicamente estos registros comerciales para WEBNEX SYSTEMS (agencia de diseño web, desarrollo a medida, SEO técnico y digitalización en Perú) utilizando ÚNICAMENTE los datos técnicos y notas independientes proporcionadas aquí:

${JSON.stringify(safeCandidates, null, 2)}

REGLAS ESTRICTAS:
1. NUNCA inventes nombres de empresas, teléfonos, sitios web, reseñas ni probabilidades de compra (%).
2. Señala necesidades digitales concretas basadas en el estado web real o metadatos HTML observados (ej. falta de HTTPS, sin meta viewport móvil, ausencia de descripción SEO, uso de plataforma gratuita o web caída).
3. Sugiere servicios específicos de WEBNEX SYSTEMS compatibles con el rubro y el diagnóstico técnico.
4. Indica qué información falta comprobar manualmente antes de contactar (ej. confirmar dominio propio o autorización de contacto).`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      analyses: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            placeId: { type: Type.STRING },
            digitalNeeds: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            recommendedWebnexServices: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            commercialRelevance: { type: Type.STRING },
            missingInformation: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            manualVerificationSteps: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            analyzedSourceNote: { type: Type.STRING },
          },
          required: [
            'placeId',
            'digitalNeeds',
            'recommendedWebnexServices',
            'commercialRelevance',
            'missingInformation',
            'manualVerificationSteps',
            'analyzedSourceNote',
          ],
        },
      },
    },
    required: ['analyses'],
  };

  const models: Array<{ model: string; useLowThinking: boolean; timeoutMs: number }> = [
    { model: 'gemini-4-hydrogen', useLowThinking: true, timeoutMs: 8000 },
    { model: 'gemini-3.1-flash-lite', useLowThinking: false, timeoutMs: 12000 },
  ];

  const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            const err: any = new Error(`Tiempo agotado en ${label}`);
            err.status = 504;
            reject(err);
          }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let lastErr: any;
  for (const candidate of models) {
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model: candidate.model,
          contents: prompt,
          config: {
            systemInstruction:
              'Eres un analista técnico comercial de WEBNEX SYSTEMS. Solo analizas datos técnicos web y notas independientes; nunca inventas datos ni probabilidades de compra.',
            ...(candidate.useLowThinking
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
              : {}),
            responseMimeType: 'application/json',
            responseSchema,
          },
        }),
        candidate.timeoutMs,
        candidate.model
      );

      const analyses = parseGeminiAnalystResponse(response.text, allowedPlaceIds);
      return { analyses, modelUsed: candidate.model };
    } catch (err: any) {
      lastErr = err;
      const status = err?.status || err?.statusCode || 500;
      const msg = String(err?.message || '');
      const shouldRetry =
        status === 503 ||
        status === 504 ||
        status === 429 ||
        status === 404 ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('high demand') ||
        msg.includes('RESOURCE_EXHAUSTED');
      if (!shouldRetry) break;
    }
  }

  throw new GeminiAnalystError(
    lastErr?.message || 'Error temporal al analizar candidatos con Gemini.',
    502,
    'GEMINI_ANALYST_FAILED'
  );
}
