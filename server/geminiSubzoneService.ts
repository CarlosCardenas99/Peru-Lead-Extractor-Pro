import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

export interface SubzoneSuggestionResult {
  subzones: string[];
  rationale: string;
  modelUsed?: string;
}

export class GeminiSubzoneError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'GeminiSubzoneError';
    this.status = status;
    this.code = code;
  }
}

export function parseSubzoneGeminiResponse(rawText: string | undefined): SubzoneSuggestionResult {
  const cleaned = (rawText || '').trim();
  if (!cleaned) {
    throw new GeminiSubzoneError('Gemini devolvió una respuesta vacía.', 502, 'GEMINI_EMPTY_RESPONSE');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new GeminiSubzoneError(
        'La respuesta de Gemini no contiene JSON estructurado válido.',
        502,
        'GEMINI_INVALID_JSON'
      );
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new GeminiSubzoneError(
        'No se pudo interpretar la respuesta JSON de Gemini.',
        502,
        'GEMINI_PARSE_ERROR'
      );
    }
  }

  const rawList: unknown[] = Array.isArray(parsed?.subzones) ? parsed.subzones : [];
  const subzones: string[] = Array.from(
    new Set<string>(
      rawList
        .filter((item): item is string => typeof item === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && s.length <= 80)
    )
  ).slice(0, 6);

  if (subzones.length === 0) {
    throw new GeminiSubzoneError(
      'No se encontraron subzonas geográficas válidas para esa ubicación.',
      422,
      'GEMINI_NO_SUBZONES'
    );
  }

  return {
    subzones,
    rationale:
      typeof parsed?.rationale === 'string' && parsed.rationale.trim()
        ? parsed.rationale.trim()
        : 'Subzonas urbanas sugeridas para segmentar búsquedas en Places API (New).',
  };
}

export async function suggestPeruvianSubzones(
  location: string,
  businessType: string
): Promise<SubzoneSuggestionResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiSubzoneError(
      'GEMINI_API_KEY no está configurada en los secretos del servidor.',
      503,
      'GEMINI_KEY_MISSING'
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const promptContents = `Sugiere entre 4 y 6 subzonas, distritos o sectores comerciales reales dentro o colindantes a "${location}, Perú" para buscar "${businessType}" mediante Google Places API (New).
REGLAS ESTRICTAS:
- Devuelve ÚNICAMENTE nombres geográficos reales de distritos o zonas urbanas del Perú.
- NUNCA menciones, inventes ni incluyas nombres de empresas, teléfonos, sitios web o reseñas.`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      subzones: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Lista de 4 a 6 subzonas o distritos reales en Perú.',
      },
      rationale: {
        type: Type.STRING,
        description: 'Breve explicación geográfica de por qué esas zonas ayudan a segmentar la búsqueda.',
      },
    },
    required: ['subzones', 'rationale'],
  };

  const candidates: Array<{ model: string; useLowThinking: boolean; timeoutMs: number }> = [
    { model: 'gemini-4-hydrogen', useLowThinking: true, timeoutMs: 7000 },
    { model: 'gemini-3.1-flash-lite', useLowThinking: false, timeoutMs: 10000 },
  ];

  const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            const err: any = new Error(`Tiempo de espera agotado en ${label} (${ms}ms)`);
            err.status = 504;
            err.code = 'GEMINI_TIMEOUT';
            reject(err);
          }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let lastErr: any;

  for (const candidate of candidates) {
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model: candidate.model,
          contents: promptContents,
          config: {
            systemInstruction:
              'Eres un asistente geográfico especializado en zonificación urbana del Perú. Solo devuelves nombres de distritos y sectores reales en JSON.',
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

      const parsed = parseSubzoneGeminiResponse(response.text);
      return {
        ...parsed,
        modelUsed: candidate.model,
      };
    } catch (err: any) {
      if (err instanceof GeminiSubzoneError) throw err;
      lastErr = err;
      const status = err?.status || err?.statusCode || 500;
      const msg = String(err?.message || '');
      const shouldTryFallback =
        status === 503 ||
        status === 504 ||
        status === 429 ||
        status === 404 ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('high demand') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('GEMINI_TIMEOUT');
      if (!shouldTryFallback) {
        break;
      }
    }
  }

  try {
    throw lastErr;
  } catch (err: any) {
    if (err instanceof GeminiSubzoneError) throw err;

    const status = err?.status || err?.statusCode || 500;
    const msg = String(err?.message || 'Error al consultar Gemini.');

    if (status === 429 || msg.includes('RESOURCE_EXHAUSTED')) {
      throw new GeminiSubzoneError(
        'Cuota temporal de Gemini alcanzada (429). Intenta nuevamente más tarde o revisa los límites en Settings > Secrets.',
        429,
        'GEMINI_QUOTA_EXCEEDED'
      );
    }
    if (status === 403 || status === 400 || msg.includes('API_KEY_INVALID') || msg.includes('PERMISSION_DENIED')) {
      throw new GeminiSubzoneError(
        'Clave de Gemini inválida o sin permisos. Verifica la configuración en Settings > Secrets.',
        403,
        'GEMINI_AUTH_ERROR'
      );
    }

    throw new GeminiSubzoneError(`Error en Gemini: ${msg}`, 502, 'GEMINI_UPSTREAM_ERROR');
  }
}
