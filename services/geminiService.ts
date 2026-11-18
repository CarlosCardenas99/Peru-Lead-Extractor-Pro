
import { GoogleGenAI } from "@google/genai";
import { BusinessLead, SearchParams } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Extrae leads usando Google Maps grounding.
 * Se enfoca en obtener información masiva filtrando únicamente por cantidad de reseñas.
 */
export async function extractLeads(params: SearchParams, iteration: number = 1): Promise<BusinessLead[]> {
  const maxReviewsText = params.maxReviews > 0 ? `con un MÁXIMO de ${params.maxReviews} reseñas` : "sin límite de reseñas";
  
  const prompt = `Actúa como un agente de inteligencia comercial experto en el mercado peruano.
Búsqueda: "${params.businessType}" en "${params.location}, Perú".
Filtro: Solo negocios ${maxReviewsText}.

REQUISITO OBLIGATORIO:
- Necesito una lista EXTENSA. No te limites. 
- Debes identificar y listar tantos negocios como sea posible (objetivo: 40-50 resultados).
- Si esta es la iteración #${iteration}, busca en sub-zonas o distritos específicos de ${params.location} para obtener resultados nuevos.

FORMATO DE SALIDA (JSON ARRAY ESTRICTO):
{
  "name": "Nombre comercial",
  "rating": "4.5",
  "reviews": "120",
  "address": "Dirección completa, Perú",
  "phone": "Número de contacto o N/A",
  "mapsUrl": "URL de Google Maps",
  "website": "URL del sitio web o 'N/A'"
}

Responde ÚNICAMENTE con el bloque JSON.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        tools: [{ googleMaps: {} }],
      }
    });

    const text = response.text || "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return [];
    }

    const rawLeads = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(rawLeads)) return [];

    return rawLeads
      .map((item: any, index: number) => ({
        id: `${Date.now()}-${iteration}-${index}-${Math.random().toString(36).substr(2, 5)}`,
        name: item.name || "Sin nombre",
        rating: String(item.rating || "N/A"),
        reviews: String(item.reviews || "0"),
        address: item.address || "Sin dirección",
        phone: item.phone || "N/A",
        mapsUrl: item.mapsUrl || "#",
        website: item.website || "N/A",
        category: params.businessType
      }))
      .filter((lead: BusinessLead) => {
        // Filtro local estricto por cantidad de reseñas
        if (params.maxReviews > 0) {
          const reviewCount = parseInt(lead.reviews.replace(/\D/g, "")) || 0;
          if (reviewCount > params.maxReviews) return false;
        }
        return true;
      });
  } catch (error: any) {
    console.error("Extraction error:", error);
    return [];
  }
}
