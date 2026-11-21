import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  CorroboratedFieldCandidate,
  FieldClassificationStatus,
  FieldResearchClassification,
  IdentityMatchSignals,
  IndependentFieldSource,
  MissingDataResearchItemInput,
  MissingDataResearchResult,
  PhoneLineType,
  ResearchableFieldKey,
  SourceConsultationAttempt,
} from '../types';
import { analyzePeruvianPhone } from '../utils/peruPhone';
import { formatIndependentSourceLabel } from '../utils/fieldCompliance';
import {
  CorroborationDetailedResult,
  corroborateLeadIndependently,
  decodeHtmlEntities,
  detectDistrictInText,
  ExtractedPeruvianPhoneItem,
  extractFirstValidEmail,
  extractPeruvianPhonesFromHtml,
  extractSafeWebsiteUrlFromNotes,
  extractSocialLinksFromHtml,
  extractStreetAddressFromText,
  stripTags,
} from './independentCorroborator';
import { DnsLookupFn, validateAndResolveSafeUrl } from './ssrfGuard';

const GEMINI_EVIDENCE_MODEL = 'gemini-4-hydrogen';

const GENERIC_BUSINESS_STOPWORDS = new Set([
  'de',
  'la',
  'las',
  'el',
  'los',
  'del',
  'y',
  'en',
  'con',
  'para',
  'por',
  'sac',
  'sa',
  'eirl',
  'srl',
  'saa',
  'scs',
  'peru',
  'lima',
  'norte',
  'sur',
  'este',
  'oeste',
  'clinica',
  'veterinaria',
  'centro',
  'consultorio',
  'salon',
  'tienda',
  'empresa',
  'servicios',
  'comercial',
  'negocios',
  'grupo',
  'inversiones',
  'corporacion',
  'asociados',
]);

const FIELD_LABELS: Record<ResearchableFieldKey, string> = {
  businessName: 'Nombre comercial',
  phone: 'Teléfono',
  address: 'Dirección',
  district: 'Distrito',
  website: 'Sitio web oficial',
  email: 'Correo electrónico',
  category: 'Categoría comercial',
};

export interface MissingDataResearchDependencies {
  fetchFn?: typeof fetch;
  dnsLookupFn?: DnsLookupFn;
  metaAppAccessToken?: string;
  geminiApiKey?: string;
}

function normalizeAsciiLower(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripCorporateLegalSuffixes(name: string): string {
  return normalizeAsciiLower(name)
    .replace(/\b(s\s*a\s*c|e\s*i\s*r\s*l|s\s*r\s*l|s\s*a\s*a|s\s*a)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractDistinctiveBrandTokens(value: string): string[] {
  const cleaned = stripCorporateLegalSuffixes(value);
  return cleaned
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !GENERIC_BUSINESS_STOPWORDS.has(t));
}

export function computeNormalizedTokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(extractDistinctiveBrandTokens(a));
  const tokensB = new Set(extractDistinctiveBrandTokens(b));
  if (tokensA.size === 0 || tokensB.size === 0) {
    const rawA = new Set(
      stripCorporateLegalSuffixes(a)
        .split(' ')
        .filter((t) => t.length >= 3)
    );
    const rawB = new Set(
      stripCorporateLegalSuffixes(b)
        .split(' ')
        .filter((t) => t.length >= 3)
    );
    if (rawA.size === 0 || rawB.size === 0) return 0;
    let shared = 0;
    for (const t of rawA) if (rawB.has(t)) shared++;
    return Number((shared / Math.max(rawA.size, rawB.size)).toFixed(2));
  }

  let shared = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) shared++;
  }
  return Number((shared / Math.max(tokensA.size, tokensB.size)).toFixed(2));
}

function isSocialHostUrl(rawUrl: string): boolean {
  try {
    const h = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).hostname
      .replace(/^www\./, '')
      .toLowerCase();
    return (
      h === 'facebook.com' ||
      h.endsWith('.facebook.com') ||
      h === 'fb.com' ||
      h.endsWith('.fb.com') ||
      h === 'instagram.com' ||
      h.endsWith('.instagram.com') ||
      h === 'tiktok.com' ||
      h.endsWith('.tiktok.com')
    );
  } catch {
    return false;
  }
}

function isDatosPeruUrl(rawUrl: string): boolean {
  try {
    const h = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).hostname
      .replace(/^www\./, '')
      .toLowerCase();
    return h === 'datosperu.org' || h.endsWith('.datosperu.org');
  } catch {
    return false;
  }
}

function isBlockedOrMirrorDirectoryUrl(rawUrl: string): boolean {
  try {
    const h = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).hostname
      .replace(/^www\./, '')
      .replace(/^pe\./, '')
      .replace(/^es\./, '')
      .toLowerCase();
    return [
      'todosnegocios.com',
      'cybo.com',
      'paginasamarillas.com.pe',
      'cylex.com.pe',
      'infoisinfo.com.pe',
      'locanto.com.pe',
    ].some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function isMetaUrl(rawUrl: string): 'facebook' | 'instagram' | null {
  try {
    const h = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).hostname
      .replace(/^www\./, '')
      .replace(/^m\./, '')
      .replace(/^web\./, '')
      .toLowerCase();
    if (h === 'facebook.com' || h === 'fb.com') return 'facebook';
    if (h === 'instagram.com') return 'instagram';
    return null;
  } catch {
    return null;
  }
}

function buildManualReviewLinks(input: MissingDataResearchItemInput): Array<{
  label: string;
  url: string;
  note: string;
}> {
  const links: Array<{ label: string; url: string; note: string }> = [];
  const nameRef = (input.sessionMapsRef?.name || '').trim();
  const districtRef = (input.sessionMapsRef?.district || input.searchDistrict || '')
    .replace(/,?\s*per[uú]$/i, '')
    .trim();

  if (input.socialOrDirectoryUrl?.trim()) {
    const provUrl = input.socialOrDirectoryUrl.trim();
    links.push({
      label: isBlockedOrMirrorDirectoryUrl(provUrl)
        ? 'Abrir referencia externa provista (solo contraste manual)'
        : 'Abrir URL social / directorio provista',
      url: provUrl,
      note: isBlockedOrMirrorDirectoryUrl(provUrl)
        ? 'Directorio agregador: verificar manualmente que no sea espejo de Google Maps antes de usarlo.'
        : 'Revisión manual directa por el usuario en su navegador.',
    });
  }

  if (nameRef) {
    const cleanQuery = [nameRef, districtRef].filter(Boolean).join(' ');
    links.push({
      label: 'Consultar registro empresarial abierto (DatosPeru / SUNAT)',
      url: `https://www.datosperu.org/buscador_empresas.php?buscar=${encodeURIComponent(nameRef)}`,
      note: 'Fuente abierta permitida por robots.txt; validar obligatoriamente CIIU/rubro y domicilio fiscal o anexo en el distrito.',
    });
    links.push({
      label: 'Contrastar en normas/registros públicos (Gob.pe / DIRIS / Municipios)',
      url: `https://www.gob.pe/busquedas?term=${encodeURIComponent(cleanQuery)}`,
      note: 'Útil para detectar establecimientos de salud humana, licencias municipales o homónimos.',
    });
    links.push({
      label: 'Buscar presencia comercial pública en Google',
      url: `https://www.google.com/search?q=${encodeURIComponent(`"${nameRef}" ${districtRef} Peru`)}`,
      note: 'Revisión manual del operador para confirmar web oficial o red social pública.',
    });
    if (!input.socialOrDirectoryUrl?.trim()) {
      links.push({
        label: 'Buscar página comercial en Facebook',
        url: `https://www.facebook.com/search/pages/?q=${encodeURIComponent(cleanQuery)}`,
        note: 'Requiere sesión del operador en Facebook (no automatizado por login wall).',
      });
    }
  }

  return links.slice(0, 5);
}

interface ParsedDatosPeruCompany {
  razonSocial: string;
  ruc: string | null;
  estado: string | null;
  condicion: string | null;
  domicilioFiscal: string | null;
  district: string | null;
  anexos: string[];
  ciiuCodes: string[];
  principalCiiu: string | null;
  allCiiuText: string;
  ciiuActivity: string | null;
  detailUrl: string;
}

/**
 * Extrae EXCLUSIVAMENTE datos corporativos públicos de una ficha empresa de DatosPeru.org.
 * Prohíbe explícitamente extraer DNIs o nombres personales de representantes legales.
 */
export function parseDatosPeruCompanyHtml(html: string, detailUrl: string): ParsedDatosPeruCompany | null {
  const plain = stripTags(html);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  let razonSocial = (h1Match ? stripTags(h1Match[1]) : '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!razonSocial && titleMatch) {
    razonSocial = stripTags(titleMatch[1])
      .replace(/^EMPRESA\s+/i, '')
      .replace(/\s*[-|]\s*DatosPeru.*$/i, '')
      .trim();
  }
  razonSocial = razonSocial.replace(/^EMPRESA\s+/i, '').trim();
  if (!razonSocial || razonSocial.length < 3) return null;

  const rucMatch = plain.match(/\bRUC[:\s]+((?:10|15|17|20)\d{9})\b/i);
  const estadoMatch = plain.match(
    /Estado(?:\s+Contribuyente)?[:\s]+([A-ZÁÉÍÓÚÑ\s]{3,30}?)(?=\s+Condici[oó]n|\s+Direcci|\s+Domicilio|$)/i
  );
  const condicionMatch = plain.match(
    /Condici[oó]n(?:\s+Contribuyente)?[:\s]+([A-ZÁÉÍÓÚÑ\s]{3,25}?)(?=\s+(?:Fecha|Fuente|Sistema|Domicilio|Direcci|CIIU|Actividad|$))/i
  );

  const domMatch = plain.match(
    /(?:Domicilio\s+Fiscal|Direcci[oó]n(?:\s+Legal)?)[:\s]+([A-Za-zÁÉÍÓÚÑáéíóúñ0-9°º.,()#/\-\s]{8,240}?)(?=\s+(?:REACTIVA\s+PER[UÚ]|PROGRAMA\s+DE\s+GARANT[IÍ]AS|Distrito|Provincia|Departamento|Establecimientos|Actividades?\s+Econ[oó]micas?|CIIU|Representantes?|ALGUNOS\s+DE\s+LOS\s+PRINCIPALES|Gerente|Tel[eé]fono|$))/i
  );

  // Capturar TODAS las actividades CIIU (Principal y Secundarias) sin arrastrar sección de ejecutivos
  const ciiuBlocks = Array.from(
    plain.matchAll(
      /\bCIIU[:\s]+(\d{4})\s*(?:[-–]\s*)?(Principal|Secundaria)?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ0-9\s.,/()\-]{4,140}?)(?=\s+(?:CIIU:|Representantes?|Gerente|Establecimientos|Comercio|Padron|Historial|ALGUNOS\s+DE\s+LOS\s+PRINCIPALES|$))/gi
    )
  );

  const ciiuCodes: string[] = [];
  const ciiuDescriptions: string[] = [];
  let principalCiiu: string | null = null;

  for (const m of ciiuBlocks) {
    const code = (m[1] || '').trim();
    const role = (m[2] || '').trim();
    const desc = (m[3] || '').replace(/\s+/g, ' ').trim();
    if (code && !ciiuCodes.includes(code)) ciiuCodes.push(code);
    const label = [code, role ? `(${role})` : '', desc].filter(Boolean).join(' ');
    if (label) ciiuDescriptions.push(label);
    if (!principalCiiu && (/principal/i.test(role) || ciiuDescriptions.length === 1)) {
      principalCiiu = label;
    }
  }

  // Fallback si la ficha usa "Actividades Económicas" sin prefijo CIIU numérico repetido
  if (ciiuDescriptions.length === 0) {
    const legacyCiiu = plain.match(
      /(?:Actividades?\s+Econ[oó]micas?(?:\s+CIIU)?|CIIU)[:\s]+(?:\d{4}\s*[-–]?\s*)?([A-Za-zÁÉÍÓÚÑáéíóúñ\s.,]{5,120}?)(?=\s+(?:Representantes?|Gerente|Establecimientos|Comercio|Padron|Historial|ALGUNOS\s+DE\s+LOS\s+PRINCIPALES|$))/i
    );
    if (legacyCiiu && legacyCiiu[1].trim()) {
      ciiuDescriptions.push(legacyCiiu[1].replace(/\s+/g, ' ').trim());
      principalCiiu = ciiuDescriptions[0];
    }
  }

  // Anexos (sin extraer nunca DNIs ni ejecutivos)
  const anexos: string[] = [];
  const anexoSectionMatch = plain.match(
    /ESTABLECIMIENTOS\s+ANEXOS([\s\S]{10,1200}?)(?=REPRESENTANTES?\s+LEGALES?|HISTORIAL|COMERCIO\s+EXTERIOR|ALGUNOS\s+DE\s+LOS|$)/i
  );
  if (anexoSectionMatch) {
    const rawAddresses = Array.from(
      anexoSectionMatch[1].matchAll(
        /\b(?:AV\.?|AVENIDA|JR\.?|JIR[OÓ]N|CALLE|CA\.?|PASAJE|MZ\.?|URB\.?)\s+[A-Za-zÁÉÍÓÚÑáéíóúñ0-9°º.,()\-\s]{8,160}/gi
      )
    ).map((m) => m[0].replace(/\s+/g, ' ').trim());
    for (const addr of rawAddresses) {
      if (!anexos.includes(addr)) anexos.push(addr);
      if (anexos.length >= 5) break;
    }
  }

  const domicilioFiscal = domMatch ? domMatch[1].replace(/\s+/g, ' ').trim() : null;
  const district =
    detectDistrictInText(domicilioFiscal || '') ||
    detectDistrictInText(anexos.join(' ')) ||
    null;

  const allCiiuText = ciiuDescriptions.join(' | ');
  const ciiuActivity = principalCiiu
    ? principalCiiu.slice(0, 140)
    : allCiiuText
    ? allCiiuText.slice(0, 140)
    : null;

  return {
    razonSocial: razonSocial.slice(0, 160),
    ruc: rucMatch ? rucMatch[1] : null,
    estado: estadoMatch ? estadoMatch[1].trim() : null,
    condicion: condicionMatch ? condicionMatch[1].trim() : null,
    domicilioFiscal,
    district,
    anexos,
    ciiuCodes,
    principalCiiu,
    allCiiuText,
    ciiuActivity,
    detailUrl,
  };
}

interface CategoryCompatibilityCheck {
  compatible: boolean;
  reason: string | null;
}

function checkCategoryCompatibilityWithCiiu(params: {
  searchCategory: string;
  razonSocial: string;
  allCiiuText: string;
  principalCiiu: string | null;
  ciiuCodes: string[];
}): CategoryCompatibilityCheck {
  const cat = normalizeAsciiLower(params.searchCategory);
  const fullText = normalizeAsciiLower(`${params.razonSocial} ${params.allCiiuText}`);
  const principalNorm = normalizeAsciiLower(params.principalCiiu || '');
  const codes = new Set(params.ciiuCodes);
  if (!cat || !fullText) return { compatible: true, reason: null };

  const domainRules: Array<{
    search: RegExp;
    conflictKeywords: RegExp;
    conflictCiiuCodes: string[];
    expectedCiiuCodes?: string[];
    expectedNameOrCiiuKeywords?: RegExp;
  }> = [
    {
      search: /veterinar|mascot|pet/,
      conflictKeywords:
        /\b(salud humana|atencion de la salud humana|psicolog\w*|ensenanza|apoyo a la ensenanza|educaci\w*|odontolog\w*|medic\w*|hospital\w*|textil\w*|confeccion\w*|prenda\w*|mineri\w*|construct\w*|ferreteri\w*|restauran\w*|panaderi\w*|calzado\w*|imprenta\w*|transporte\w*|automotriz|autolavado|vehicul\w*|inmobiliari\w*|abogad\w*|cett|car)\b/,
      conflictCiiuCodes: ['8610', '8620', '8690', '8510', '8521', '8522', '8530', '8541', '8542', '8549', '8550', '1410', '1430', '4520', '4530', '4100', '5610', '5630'],
      expectedCiiuCodes: ['7500'],
      expectedNameOrCiiuKeywords: /\b(veterinar\w*|mascot\w*|pet\b|canin\w*|animal\w*|zoo\w*)\b/,
    },
    {
      search: /dental|odontolog/,
      conflictKeywords:
        /\b(veterinar\w*|textil\w*|construct\w*|ferreteri\w*|restauran\w*|automotriz|mineri\w*|transporte\w*|psicolog\w*|ensenanza)\b/,
      conflictCiiuCodes: ['7500', '1410', '4100', '4520', '5610'],
      expectedCiiuCodes: ['8620'],
      expectedNameOrCiiuKeywords: /\b(dental\w*|odontolog\w*)\b/,
    },
    {
      search: /ferreteri|construct/,
      conflictKeywords:
        /\b(veterinar\w*|odontolog\w*|clinica dental|salud humana|psicolog\w*|peluqueri\w*|salon de belleza|restauran\w*|ensenanza)\b/,
      conflictCiiuCodes: ['7500', '8620', '8690', '8550', '5610'],
    },
    {
      search: /restauran|polleri|comida|cafeteri/,
      conflictKeywords:
        /\b(veterinar\w*|odontolog\w*|salud humana|ferreteri\w*|mineri\w*|construct\w*|abogad\w*|ensenanza)\b/,
      conflictCiiuCodes: ['7500', '8620', '8690', '8550', '4100'],
    },
  ];

  for (const rule of domainRules) {
    if (!rule.search.test(cat)) continue;

    if (rule.conflictKeywords.test(fullText) || rule.conflictKeywords.test(principalNorm)) {
      return {
        compatible: false,
        reason: `Contradicción determinante de rubro/CIIU: "${params.razonSocial}" (${params.principalCiiu || params.allCiiuText}) no corresponde a "${params.searchCategory}".`,
      };
    }

    const hitConflictCode = rule.conflictCiiuCodes.find((c) => codes.has(c));
    if (hitConflictCode) {
      return {
        compatible: false,
        reason: `CIIU ${hitConflictCode} incompatible con "${params.searchCategory}" (${params.principalCiiu || params.allCiiuText}).`,
      };
    }

    // Si hay códigos CIIU declarados y ninguno corresponde al giro ni el nombre/CIIU menciona el rubro esperado, bloquear homónimos ambiguos
    if (codes.size > 0 && rule.expectedCiiuCodes && rule.expectedNameOrCiiuKeywords) {
      const hasExpectedCode = rule.expectedCiiuCodes.some((c) => codes.has(c));
      const hasExpectedKeyword = rule.expectedNameOrCiiuKeywords.test(fullText);
      if (!hasExpectedCode && !hasExpectedKeyword) {
        return {
          compatible: false,
          reason: `Los CIIU declarados (${Array.from(codes).join(', ')}) no acreditan actividad compatible con "${params.searchCategory}".`,
        };
      }
    }
  }
  return { compatible: true, reason: null };
}

export function passesDatosPeruIdentityGate(
  company: ParsedDatosPeruCompany,
  ref: {
    businessName?: string;
    district?: string;
    address?: string;
    category?: string;
  }
): {
  accepted: boolean;
  matchedDistrictAddress: string | null;
  branchEvidenceInDistrict: boolean;
  reason: string;
} {
  const targetName = (ref.businessName || '').trim();
  const targetDistrictRaw = (ref.district || '').replace(/,?\s*per[uú]$/i, '').trim();
  const targetDistrict = normalizeAsciiLower(targetDistrictRaw);
  const targetCategory = (ref.category || '').trim();

  // 1. Estado activo obligatorio
  if (company.estado && /BAJA|SUSPENSI/i.test(company.estado)) {
    return {
      accepted: false,
      matchedDistrictAddress: null,
      branchEvidenceInDistrict: false,
      reason: `Contribuyente "${company.razonSocial}" figura en estado ${company.estado}.`,
    };
  }

  // 2. Comprobación determinante de Rubro / CIIU (bloquea aunque coincida palabra de marca)
  if (targetCategory) {
    const catCheck = checkCategoryCompatibilityWithCiiu({
      searchCategory: targetCategory,
      razonSocial: company.razonSocial,
      allCiiuText: company.allCiiuText,
      principalCiiu: company.principalCiiu,
      ciiuCodes: company.ciiuCodes,
    });
    if (!catCheck.compatible) {
      return {
        accepted: false,
        matchedDistrictAddress: null,
        branchEvidenceInDistrict: false,
        reason: catCheck.reason || `Actividad incompatible con el rubro "${targetCategory}".`,
      };
    }
  }

  // 3. Coincidencia de marca y validación anti-homónimo por palabras solas
  if (targetName) {
    const mapsDistinct = extractDistinctiveBrandTokens(targetName);
    const compDistinct = new Set(extractDistinctiveBrandTokens(company.razonSocial));
    const sharedBrand = mapsDistinct.filter((t) => compDistinct.has(t));
    const sim = computeNormalizedTokenSimilarity(targetName, company.razonSocial);

    if (mapsDistinct.length > 0 && sharedBrand.length === 0) {
      return {
        accepted: false,
        matchedDistrictAddress: null,
        branchEvidenceInDistrict: false,
        reason: `Sin coincidencia en tokens distintivos de marca entre "${targetName}" y "${company.razonSocial}".`,
      };
    }
    if (sim < 0.35 && sharedBrand.length === 0) {
      return {
        accepted: false,
        matchedDistrictAddress: null,
        branchEvidenceInDistrict: false,
        reason: `Similitud insuficiente (${sim}) entre "${targetName}" y "${company.razonSocial}".`,
      };
    }
  }

  // 4. Comprobación geográfica obligatoria: Distrito y Domicilio Fiscal o Establecimiento Anexo en el distrito
  let matchedDistrictAddress: string | null = null;
  let branchEvidenceInDistrict = false;

  if (targetDistrict) {
    const matchingAnexo = company.anexos.find((a) => normalizeAsciiLower(a).includes(targetDistrict));
    const domNorm = normalizeAsciiLower(company.domicilioFiscal || '');
    const companyDistrictNorm = normalizeAsciiLower(company.district || '');

    if (matchingAnexo) {
      matchedDistrictAddress = matchingAnexo;
      branchEvidenceInDistrict = true;
    } else if (domNorm && domNorm.includes(targetDistrict)) {
      matchedDistrictAddress = company.domicilioFiscal;
    } else if (!company.domicilioFiscal && companyDistrictNorm && companyDistrictNorm.includes(targetDistrict)) {
      matchedDistrictAddress = null;
    } else {
      const foundGeo = company.district || company.domicilioFiscal || 'otro distrito no coincidente';
      return {
        accepted: false,
        matchedDistrictAddress: null,
        branchEvidenceInDistrict: false,
        reason: `Contradicción geográfica relevante: "${company.razonSocial}" (${company.ruc ? `RUC ${company.ruc}` : 'sin RUC'}) registra ubicación en "${foundGeo}" sin coincidencia ni establecimiento anexo en "${targetDistrictRaw}".`,
      };
    }
  } else {
    matchedDistrictAddress = company.domicilioFiscal || company.anexos[0] || null;
  }

  // 5. Si existen ambos domicilio/anexo y dirección de referencia, verificar que no sean vías totalmente ajenas cuando solo hay 1 token compartido
  if (ref.address && matchedDistrictAddress) {
    const addrSim = computeNormalizedTokenSimilarity(ref.address, matchedDistrictAddress);
    const mapsDistinct = extractDistinctiveBrandTokens(targetName);
    const compDistinct = extractDistinctiveBrandTokens(company.razonSocial);
    // Si solo coincide 1 token genérico corto de marca y la dirección fiscal en el mismo distrito tampoco coincide con la calle ni hay código CIIU exacto
    if (mapsDistinct.length === 1 && compDistinct.length > 1 && addrSim === 0 && company.ciiuCodes.length === 0) {
      return {
        accepted: false,
        matchedDistrictAddress: null,
        branchEvidenceInDistrict: false,
        reason: `Coincidencia parcial de una sola palabra sin respaldo CIIU ni coincidencia de dirección entre "${ref.address}" y "${matchedDistrictAddress}".`,
      };
    }
  }

  return {
    accepted: true,
    matchedDistrictAddress,
    branchEvidenceInDistrict,
    reason: branchEvidenceInDistrict
      ? `Identidad validada por rubro/CIIU y establecimiento anexo en ${targetDistrictRaw} (${company.razonSocial}${company.ruc ? ` · RUC ${company.ruc}` : ''}).`
      : `Identidad validada por rubro/CIIU, marca y distrito (${company.razonSocial}${company.ruc ? ` · RUC ${company.ruc}` : ''}).`,
  };
}

async function fetchPublicTextSafely(
  rawUrl: string,
  fetchFn: typeof fetch,
  dnsLookupFn?: DnsLookupFn,
  options?: { allowRedirectFollow?: boolean; timeoutMs?: number }
): Promise<
  | { ok: true; url: string; status: number; contentType: string; body: string }
  | { ok: false; status: number | null; blockedOrRestricted: boolean; reason: string; redirectLocation?: string | null }
> {
  let currentUrl = rawUrl.trim();
  const maxHops = options?.allowRedirectFollow ? 2 : 0;

  for (let hop = 0; hop <= maxHops; hop++) {
    const validation = await validateAndResolveSafeUrl(currentUrl, dnsLookupFn);
    if (validation.ok === false) {
      return {
        ok: false,
        status: null,
        blockedOrRestricted: false,
        reason: validation.reason,
      };
    }

    const targetUrl = validation.parsedUrl.toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 5500);
    try {
      const res = await fetchFn(targetUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'WEBNEX-IndependentVerifier/1.0 (+https://webnex.systems)',
          Accept: 'text/html,application/json;q=0.9,*/*;q=0.1',
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (options?.allowRedirectFollow && location && hop < maxHops) {
          currentUrl = new URL(location, targetUrl).toString();
          continue;
        }
        return {
          ok: false,
          status: res.status,
          blockedOrRestricted: true,
          redirectLocation: location,
          reason: `Redirección HTTP ${res.status}${location ? ` hacia ${location}` : ''}.`,
        };
      }

      if (res.status === 401 || res.status === 403 || res.status === 429) {
        return {
          ok: false,
          status: res.status,
          blockedOrRestricted: true,
          reason: `Fuente restringió o bloqueó la consulta automatizada (HTTP ${res.status}).`,
        };
      }

      if (res.status >= 400) {
        return {
          ok: false,
          status: res.status,
          blockedOrRestricted: false,
          reason: `Recurso no disponible (HTTP ${res.status}).`,
        };
      }

      const contentType = res.headers.get('content-type') || '';
      const body = (await res.text()).slice(0, 140000);
      return { ok: true, url: targetUrl, status: res.status, contentType, body };
    } catch {
      return {
        ok: false,
        status: null,
        blockedOrRestricted: false,
        reason: 'Timeout o error de red consultando la fuente.',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    status: null,
    blockedOrRestricted: true,
    reason: 'Límite de redirecciones alcanzado.',
  };
}

async function analyzeUserEvidenceWithGeminiSafe(
  evidenceText: string,
  missingFields: string[],
  apiKey: string
): Promise<{
  businessName?: string;
  phone?: string;
  address?: string;
  district?: string;
  email?: string;
  category?: string;
} | null> {
  if (!apiKey || evidenceText.trim().length < 15 || missingFields.length === 0) return null;

  const ai = new GoogleGenAI({ apiKey });
  const prompt = [
    'Eres un extractor estricto de evidencia comercial verificada en Perú.',
    'Analiza EXCLUSIVAMENTE el texto proporcionado por el usuario.',
    'REGLAS OBLIGATORIAS:',
    '1. NUNCA inventes, supongas ni extrapoles teléfonos, correos, direcciones ni nombres que no aparezcan escritos literalmente en el texto.',
    '2. Si un campo no aparece explícitamente en el texto, devuelve cadena vacía "".',
    `3. Campos prioritarios buscados: ${missingFields.join(', ')}.`,
    'Devuelve estrictamente JSON con claves: {"businessName":"","phone":"","address":"","district":"","email":"","category":""}.',
    '',
    'TEXTO DE EVIDENCIA:',
    evidenceText.slice(0, 2500),
  ].join('\n');

  const response = await ai.models.generateContent({
    model: GEMINI_EVIDENCE_MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    },
  });

  const rawText = (response.text || '').trim();
  if (!rawText) return null;

  let parsed: any = null;
  try {
    const cleanJson = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    parsed = JSON.parse(cleanJson);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const sourceDigits = evidenceText.replace(/\D/g, '');
  const sourceLower = normalizeAsciiLower(evidenceText);

  const result: {
    businessName?: string;
    phone?: string;
    address?: string;
    district?: string;
    email?: string;
    category?: string;
  } = {};

  // Guardia estricta anti-fabricación: los dígitos del teléfono deben aparecer literalmente en el texto fuente
  if (typeof parsed.phone === 'string' && parsed.phone.trim()) {
    const phoneParsed = analyzePeruvianPhone(parsed.phone.trim());
    const localDigits = phoneParsed.e164 ? phoneParsed.e164.replace(/^\+51/, '') : '';
    if (
      phoneParsed.isValidFormat &&
      phoneParsed.formatted &&
      localDigits.length >= 7 &&
      sourceDigits.includes(localDigits)
    ) {
      result.phone = phoneParsed.formatted;
    }
  }

  if (typeof parsed.email === 'string' && parsed.email.trim()) {
    const cleanEmail = parsed.email.trim().toLowerCase();
    if (evidenceText.toLowerCase().includes(cleanEmail)) {
      result.email = cleanEmail;
    }
  }

  const containsTokens = (candidateStr: string): boolean => {
    const tokens = normalizeAsciiLower(candidateStr)
      .split(' ')
      .filter((t) => t.length >= 3);
    if (tokens.length === 0) return false;
    const hits = tokens.filter((t) => sourceLower.includes(t));
    return hits.length / tokens.length >= 0.7;
  };

  if (typeof parsed.businessName === 'string' && parsed.businessName.trim() && containsTokens(parsed.businessName)) {
    result.businessName = parsed.businessName.trim().slice(0, 160);
  }
  if (typeof parsed.address === 'string' && parsed.address.trim() && containsTokens(parsed.address)) {
    result.address = parsed.address.trim().slice(0, 180);
  }
  if (typeof parsed.district === 'string' && parsed.district.trim() && containsTokens(parsed.district)) {
    result.district = parsed.district.trim().slice(0, 120);
  }
  if (typeof parsed.category === 'string' && parsed.category.trim() && containsTokens(parsed.category)) {
    result.category = parsed.category.trim().slice(0, 120);
  }

  return result;
}

export function compareIdentitySignals(params: {
  candidates: MissingDataResearchResult['corroboration']['candidates'];
  allIndependentPhones: Array<ExtractedPeruvianPhoneItem & { evidenceUrl: string }>;
  sessionMapsRef?: MissingDataResearchItemInput['sessionMapsRef'];
  searchDistrict?: string;
  searchCategory?: string;
  rejectedCorporateCandidates?: string[];
}): {
  identityMatch: IdentityMatchSignals;
  contradictionAlerts: string[];
  hasPhoneContradiction: boolean;
  matchedMapsPhone: (ExtractedPeruvianPhoneItem & { evidenceUrl: string }) | null;
} {
  const mapsName = (params.sessionMapsRef?.name || '').trim();
  const mapsAddress = (params.sessionMapsRef?.address || '').trim();
  const mapsDistrict = (params.sessionMapsRef?.district || params.searchDistrict || '')
    .replace(/,?\s*per[uú]$/i, '')
    .trim();
  const mapsPhoneRaw = (params.sessionMapsRef?.phone || '').trim();
  const mapsPhoneParsed = analyzePeruvianPhone(mapsPhoneRaw);

  const matchedSignals: Array<'name' | 'district' | 'address' | 'phone' | 'category'> = [];
  const conflictingSignals: Array<'name' | 'district' | 'address' | 'phone' | 'category'> = [];
  const contradictionAlerts: string[] = [];
  const rejectionReasons = [...(params.rejectedCorporateCandidates || [])];

  // 1. Nombre comercial (ignorar placeholders o contexto del usuario)
  let nameSimilarity = 0;
  if (params.candidates.businessName?.value && mapsName) {
    nameSimilarity = computeNormalizedTokenSimilarity(params.candidates.businessName.value, mapsName);
    const sharedBrand = extractDistinctiveBrandTokens(params.candidates.businessName.value).some((t) =>
      extractDistinctiveBrandTokens(mapsName).includes(t)
    );
    if (nameSimilarity >= 0.45 || sharedBrand) {
      matchedSignals.push('name');
    } else if (params.candidates.businessName.source !== 'user_manual_entry') {
      conflictingSignals.push('name');
      contradictionAlerts.push(
        `El nombre hallado en fuente independiente ("${params.candidates.businessName.value}") no coincide claramente con la referencia de Maps ("${mapsName}").`
      );
    }
  }

  // 2. Distrito (SOLO contar como señal independiente si NO proviene de 'user_search_context')
  let districtMatches: boolean | null = null;
  if (
    params.candidates.district?.value &&
    params.candidates.district.source !== 'user_search_context' &&
    mapsDistrict
  ) {
    const a = normalizeAsciiLower(params.candidates.district.value);
    const b = normalizeAsciiLower(mapsDistrict);
    districtMatches = a.includes(b) || b.includes(a);
    if (districtMatches) matchedSignals.push('district');
    else {
      conflictingSignals.push('district');
      contradictionAlerts.push(
        `Distrito independiente ("${params.candidates.district.value}") difiere del distrito consultado ("${mapsDistrict}").`
      );
    }
  }

  // 3. Dirección independiente
  let addressMatches: boolean | null = null;
  if (params.candidates.address?.value && mapsAddress) {
    const simAddr = computeNormalizedTokenSimilarity(params.candidates.address.value, mapsAddress);
    addressMatches = simAddr >= 0.35;
    if (addressMatches) matchedSignals.push('address');
  }

  // 4. Compatibilidad de categoría cuando proviene de fuente independiente
  let categoryCompatible: boolean | null = null;
  if (
    params.searchCategory &&
    params.candidates.category?.value &&
    params.candidates.category.source !== 'user_search_context'
  ) {
    const catCheck = checkCategoryCompatibilityWithCiiu({
      searchCategory: params.searchCategory,
      razonSocial: params.candidates.businessName?.value || '',
      allCiiuText: params.candidates.category.value,
      principalCiiu: params.candidates.category.value,
      ciiuCodes: [],
    });
    categoryCompatible = catCheck.compatible;
    if (catCheck.compatible) {
      matchedSignals.push('category');
    } else {
      conflictingSignals.push('category');
      if (catCheck.reason) contradictionAlerts.push(catCheck.reason);
    }
  }

  // 5. Teléfono (compara contra TODOS los teléfonos válidos encontrados en web/evidencia)
  let phoneMatches: boolean | null = null;
  let hasPhoneContradiction = false;
  let matchedMapsPhone: (ExtractedPeruvianPhoneItem & { evidenceUrl: string }) | null = null;

  const uniqueE164Found = Array.from(
    new Map(params.allIndependentPhones.map((p) => [p.e164, p])).values()
  );

  if (uniqueE164Found.length > 0 && mapsPhoneParsed.isValidFormat && mapsPhoneParsed.e164) {
    const foundMatch = uniqueE164Found.find((p) => p.e164 === mapsPhoneParsed.e164) || null;
    if (foundMatch) {
      phoneMatches = true;
      matchedMapsPhone = foundMatch;
      matchedSignals.push('phone');
    } else {
      phoneMatches = false;
      hasPhoneContradiction = true;
      conflictingSignals.push('phone');
      const foundList = uniqueE164Found.map((p) => p.formatted).slice(0, 3).join(', ');
      contradictionAlerts.push(
        `Teléfono contradictorio: la fuente independiente registra ${foundList}, distinto al teléfono en sesión de Google Maps (${mapsPhoneParsed.formatted}). No se auto-completa hasta revisión manual.`
      );
    }
  }

  let overallConfidence: IdentityMatchSignals['overallConfidence'] = 'unconfirmed';
  let identityStatusLabel: IdentityMatchSignals['identityStatusLabel'] = 'IDENTIDAD NO CONFIRMADA';

  if (
    hasPhoneContradiction ||
    conflictingSignals.includes('name') ||
    conflictingSignals.includes('category') ||
    conflictingSignals.includes('district')
  ) {
    overallConfidence = 'conflict';
    identityStatusLabel = 'CONFLICTO DE IDENTIDAD';
  } else if (
    matchedSignals.includes('name') &&
    (matchedSignals.includes('phone') || matchedSignals.includes('address')) &&
    matchedSignals.length >= 2
  ) {
    overallConfidence = 'high';
    identityStatusLabel = 'IDENTIDAD CONFIRMADA';
  } else if (
    matchedSignals.length >= 2 ||
    (matchedSignals.includes('phone') && Boolean(params.candidates.phone)) ||
    (matchedSignals.includes('address') && Boolean(params.candidates.address))
  ) {
    overallConfidence = 'medium';
    identityStatusLabel = 'COINCIDENCIA PARCIAL';
  } else {
    overallConfidence = 'unconfirmed';
    identityStatusLabel = 'IDENTIDAD NO CONFIRMADA';
  }

  const summary =
    overallConfidence === 'conflict'
      ? `CONFLICTO DE IDENTIDAD (${conflictingSignals.join(', ')}): revisar manualmente; se bloqueó asignación automática.`
      : overallConfidence === 'high'
      ? `IDENTIDAD CONFIRMADA multiseñal (${matchedSignals.join(', ')}).`
      : overallConfidence === 'medium'
      ? `COINCIDENCIA PARCIAL (${matchedSignals.join(', ')}): requiere verificación adicional antes de cerrar ficha completa.`
      : rejectionReasons.length > 0
      ? `IDENTIDAD NO CONFIRMADA — homónimos/candidatos rechazados por validación estricta: ${rejectionReasons[0]}`
      : 'IDENTIDAD NO CONFIRMADA — evidencia independiente insuficiente (sin respaldo multiseñal de rubro, distrito/dirección o teléfono).';

  return {
    identityMatch: {
      overallConfidence,
      identityStatusLabel,
      matchedSignals,
      conflictingSignals,
      nameSimilarity,
      districtMatches,
      addressMatches,
      phoneMatches,
      categoryCompatible,
      rejectionReasons,
      summary,
    },
    contradictionAlerts,
    hasPhoneContradiction,
    matchedMapsPhone,
  };
}

export async function researchMissingLeadData(
  input: MissingDataResearchItemInput,
  deps?: MissingDataResearchDependencies
): Promise<MissingDataResearchResult> {
  const researchedAt = new Date().toISOString();
  const fetchFn = deps?.fetchFn || fetch;
  const sourceAttempts: SourceConsultationAttempt[] = [];
  const checkedUrls: string[] = [];
  const allPhones: Array<ExtractedPeruvianPhoneItem & { evidenceUrl: string }> = [];
  const discoveredSocials: string[] = [];
  const rejectedCorporateCandidates: string[] = [];

  const registerPhones = (items: ExtractedPeruvianPhoneItem[], evidenceUrl: string) => {
    for (const item of items) {
      if (!allPhones.some((p) => p.e164 === item.e164)) {
        allPhones.push({ ...item, evidenceUrl });
      }
    }
  };

  // Separar explícitamente URLs provistas entre web oficial, red social Meta, DatosPeru o directorio agregador protegido
  const rawOfficialInput = (input.officialWebsiteUrl || '').trim();
  const rawExtraUrl = (input.socialOrDirectoryUrl || '').trim();

  const isNonOfficialExternal = (u: string): boolean =>
    Boolean(u) && (isSocialHostUrl(u) || isDatosPeruUrl(u) || isBlockedOrMirrorDirectoryUrl(u));

  const officialWebCandidate =
    (rawOfficialInput && !isNonOfficialExternal(rawOfficialInput) ? rawOfficialInput : '') ||
    (rawExtraUrl && !isNonOfficialExternal(rawExtraUrl) ? rawExtraUrl : '') ||
    extractSafeWebsiteUrlFromNotes(input.notesText || '') ||
    extractSafeWebsiteUrlFromNotes(input.userProvidedEvidenceText || '') ||
    '';

  const cleanSearchDistrict = (input.searchDistrict || input.sessionMapsRef?.district || '')
    .replace(/,?\s*per[uú]$/i, '')
    .trim();

  // 1. Adaptador Web Oficial del Comercio
  let corroboration: CorroborationDetailedResult = await corroborateLeadIndependently(
    {
      placeId: input.placeId,
      officialWebsiteUrl: officialWebCandidate || null,
      notesText: input.notesText,
      searchCategory: input.searchCategory,
      searchDistrict: cleanSearchDistrict,
    },
    { fetchFn, dnsLookupFn: deps?.dnsLookupFn }
  );

  for (const p of corroboration.allFoundPhones) {
    if (!allPhones.some((x) => x.e164 === p.e164)) {
      allPhones.push(p);
    }
  }
  for (const s of corroboration.discoveredSocialLinks) {
    if (!discoveredSocials.includes(s)) discoveredSocials.push(s);
  }
  checkedUrls.push(...corroboration.checkedUrls);

  if (officialWebCandidate) {
    const foundWebFields = [
      corroboration.candidates.businessName ? 'nombre' : null,
      corroboration.candidates.phone ? 'teléfono' : null,
      corroboration.candidates.address ? 'dirección' : null,
      corroboration.candidates.email ? 'correo' : null,
    ].filter(Boolean);

    const webBlocked =
      corroboration.websiteStatus === 'unverified_inconclusive' ||
      corroboration.websiteStatus === 'social_only';

    sourceAttempts.push({
      sourceId: 'official_website',
      sourceName: 'Sitio web oficial del negocio',
      status:
        corroboration.checkedUrls.length > 0 && foundWebFields.length > 0
          ? 'found'
          : webBlocked
          ? 'blocked_or_restricted'
          : 'not_found',
      httpStatus: corroboration.checkedUrls.length > 0 ? 200 : null,
      checkedUrl: corroboration.checkedUrls[0] || officialWebCandidate,
      retentionPermitted: true,
      costNote: '$0 (HTTP público SSRF-safe)',
      detail: corroboration.summary,
    });
  } else {
    sourceAttempts.push({
      sourceId: 'official_website',
      sourceName: 'Sitio web oficial del negocio',
      status: 'not_found',
      httpStatus: null,
      checkedUrl: null,
      retentionPermitted: true,
      costNote: '$0',
      detail: rawOfficialInput && isSocialHostUrl(rawOfficialInput)
        ? 'La URL registrada pertenece a red social; se deriva al adaptador Meta.'
        : 'El negocio no registra sitio web oficial propio para consulta automatizada.',
    });
  }

  // 2. Adaptador Meta / Facebook / Instagram (mecanismos autorizados, SIN evadir login wall)
  const metaCandidateUrls = Array.from(
    new Set(
      [
        rawExtraUrl && isMetaUrl(rawExtraUrl) ? rawExtraUrl : '',
        rawOfficialInput && isMetaUrl(rawOfficialInput) ? rawOfficialInput : '',
        ...discoveredSocials,
      ].filter(Boolean)
    )
  );

  const metaToken =
    deps?.metaAppAccessToken ??
    process.env.META_APP_ACCESS_TOKEN ??
    process.env.FB_GRAPH_TOKEN ??
    '';

  if (metaCandidateUrls.length === 0) {
    sourceAttempts.push({
      sourceId: 'meta_social',
      sourceName: 'Facebook / Instagram (mecanismo autorizado)',
      status: 'not_found',
      httpStatus: null,
      checkedUrl: null,
      retentionPermitted: false,
      costNote: '$0',
      detail:
        'Sin URL pública de Facebook/Instagram registrada. Sin Meta App Token / scraping no autorizado, no se consultan búsquedas privadas tras login wall.',
    });
  } else {
    const socialUrl = metaCandidateUrls[0];
    const platform = isMetaUrl(socialUrl);
    if (metaToken && platform) {
      const endpoint =
        platform === 'instagram'
          ? `https://graph.facebook.com/v20.0/instagram_oembed?url=${encodeURIComponent(socialUrl)}&access_token=${encodeURIComponent(metaToken)}`
          : `https://graph.facebook.com/v20.0/oembed_page?url=${encodeURIComponent(socialUrl)}&access_token=${encodeURIComponent(metaToken)}`;

      const graphFetch = await fetchPublicTextSafely(endpoint, fetchFn, deps?.dnsLookupFn, {
        allowRedirectFollow: false,
        timeoutMs: 4500,
      });

      if (graphFetch.ok === true) {
        try {
          const payload = JSON.parse(graphFetch.body);
          const pageTitle = String(payload.author_name || payload.title || '').trim();
          if (pageTitle && !corroboration.candidates.businessName) {
            corroboration.candidates.businessName = {
              value: pageTitle.slice(0, 160),
              source: 'meta_graph_api',
              evidenceUrl: socialUrl,
              verifiedAt: researchedAt,
              confidence: 'medium',
            };
          }
          sourceAttempts.push({
            sourceId: 'meta_social',
            sourceName: 'Meta Graph oEmbed API',
            status: pageTitle ? 'found' : 'not_found',
            httpStatus: graphFetch.status,
            checkedUrl: socialUrl,
            retentionPermitted: true,
            costNote: '$0 (requiere Meta App Token / permiso oEmbed Read)',
            detail: pageTitle
              ? `Metadatos autorizados recibidos vía oEmbed (${pageTitle}). Nota: oEmbed de Meta no expone teléfono ni dirección.`
              : 'oEmbed respondió sin metadatos de página comercial.',
          });
        } catch {
          sourceAttempts.push({
            sourceId: 'meta_social',
            sourceName: 'Meta Graph oEmbed API',
            status: 'error',
            httpStatus: graphFetch.status,
            checkedUrl: socialUrl,
            retentionPermitted: false,
            costNote: '$0',
            detail: 'Respuesta JSON ilegible de Meta oEmbed.',
          });
        }
      } else {
        sourceAttempts.push({
          sourceId: 'meta_social',
          sourceName: 'Meta Graph oEmbed API',
          status: 'blocked_or_restricted',
          httpStatus: graphFetch.status,
          checkedUrl: socialUrl,
          retentionPermitted: false,
          costNote: '$0',
          detail: graphFetch.reason,
        });
      }
    } else {
      // Sin token oEmbed: comprobar honestamente si la URL pública impone login wall (302 -> /login o 400/403)
      const probe = await fetchPublicTextSafely(socialUrl, fetchFn, deps?.dnsLookupFn, {
        allowRedirectFollow: false,
        timeoutMs: 4000,
      });
      const redirectedToLogin =
        probe.ok === false &&
        Boolean(probe.redirectLocation && /\/(login|accounts\/login)/i.test(probe.redirectLocation));

      sourceAttempts.push({
        sourceId: 'meta_social',
        sourceName: 'Facebook / Instagram (verificación de acceso)',
        status: 'blocked_or_restricted',
        httpStatus: probe.status,
        checkedUrl: socialUrl,
        retentionPermitted: false,
        costNote: '$0 (Meta oEmbed Read requiere App Review)',
        detail: redirectedToLogin && probe.ok === false
          ? `Meta impuso login wall (HTTP ${probe.status ?? 302} hacia ${probe.redirectLocation ?? '/login'}). Se prohíbe evadir autenticación o raspar páginas tras login.`
          : 'Sin token autorizado de Meta Graph API (META_APP_ACCESS_TOKEN); consulta automatizada restringida por políticas de Meta. Usa los enlaces de revisión manual.',
      });
    }
  }

    const directoryRefUrl =
      (rawExtraUrl && isBlockedOrMirrorDirectoryUrl(rawExtraUrl) ? rawExtraUrl : '') ||
      (rawOfficialInput && isBlockedOrMirrorDirectoryUrl(rawOfficialInput) ? rawOfficialInput : '');

    if (directoryRefUrl) {
      const dirProbe = await fetchPublicTextSafely(directoryRefUrl, fetchFn, deps?.dnsLookupFn, {
        allowRedirectFollow: false,
        timeoutMs: 4000,
      });
      sourceAttempts.push({
        sourceId: 'directory_reference',
        sourceName: 'Directorio agregador externo (contraste manual)',
        status: dirProbe.ok === true ? 'not_found' : 'blocked_or_restricted',
        httpStatus: dirProbe.status,
        checkedUrl: directoryRefUrl,
        retentionPermitted: false,
        costNote: '$0 (no se evade antibot ni se almacena automáticamente)',
        detail:
          dirProbe.ok === false
            ? `Acceso restringido (${dirProbe.reason}). Además, directorios como TodosNegocios/Cybo pueden reflejar datos de Google Maps; úsalos solo para contraste manual y nunca los almacenes sin verificación primaria.`
            : 'Directorio de contraste manual: no se extrae automáticamente por posible origen espejo de Google Maps.',
      });
    }

  // 3. Adaptador Directorio Empresarial Abierto Permitido (DatosPeru.org — robots.txt Allow: /)
  const needsCorporateIdentityOrAddress =
    !corroboration.candidates.businessName || !corroboration.candidates.address;

  const explicitDatosPeruUrl = isDatosPeruUrl(rawExtraUrl) ? rawExtraUrl : null;
  const searchQueryBase = stripCorporateLegalSuffixes(input.sessionMapsRef?.name || '');

  if (explicitDatosPeruUrl || (needsCorporateIdentityOrAddress && searchQueryBase.length >= 3)) {
    let matchedCompany: ParsedDatosPeruCompany | null = null;
    let matchedGate: ReturnType<typeof passesDatosPeruIdentityGate> | null = null;
    let lastHttpStatus: number | null = null;
    let lastCheckedUrl: string | null = explicitDatosPeruUrl;
    let blockedReason: string | null = null;

    if (explicitDatosPeruUrl && /empresa-.*\.php/i.test(explicitDatosPeruUrl)) {
      const res = await fetchPublicTextSafely(explicitDatosPeruUrl, fetchFn, deps?.dnsLookupFn, {
        allowRedirectFollow: true,
        timeoutMs: 5000,
      });
      if (res.ok === true) {
        lastHttpStatus = res.status;
        lastCheckedUrl = res.url;
        const parsed = parseDatosPeruCompanyHtml(res.body, res.url);
        if (parsed) {
          const gate = passesDatosPeruIdentityGate(parsed, {
            businessName: input.sessionMapsRef?.name,
            district: cleanSearchDistrict,
            address: input.sessionMapsRef?.address,
            category: input.searchCategory || corroboration.candidates.category?.value,
          });
          if (gate.accepted) {
            matchedCompany = parsed;
            matchedGate = gate;
          } else {
            blockedReason = gate.reason;
            rejectedCorporateCandidates.push(gate.reason);
          }
        }
      } else {
        lastHttpStatus = res.status;
        blockedReason = res.reason;
      }
    } else if (searchQueryBase.length >= 3) {
      const searchUrl = `https://www.datosperu.org/buscador_empresas.php?buscar=${encodeURIComponent(
        searchQueryBase
      )}`;
      lastCheckedUrl = searchUrl;
      const searchRes = await fetchPublicTextSafely(searchUrl, fetchFn, deps?.dnsLookupFn, {
        allowRedirectFollow: true,
        timeoutMs: 5000,
      });
      if (searchRes.ok === true) {
        lastHttpStatus = searchRes.status;
        const linkMatches = Array.from(
          searchRes.body.matchAll(/href=["'](empresa-[^"'#\s]+\.php)["']/gi)
        ).map((m) => `https://www.datosperu.org/${m[1]}`);
        const uniqueDetailUrls = Array.from(new Set(linkMatches)).slice(0, 3);

        for (const detailUrl of uniqueDetailUrls) {
          const detailRes = await fetchPublicTextSafely(detailUrl, fetchFn, deps?.dnsLookupFn, {
            allowRedirectFollow: true,
            timeoutMs: 5000,
          });
          if (detailRes.ok === false) {
            lastHttpStatus = detailRes.status;
            continue;
          }
          lastHttpStatus = detailRes.status;
          lastCheckedUrl = detailRes.url;
          const parsed = parseDatosPeruCompanyHtml(detailRes.body, detailRes.url);
          if (!parsed) continue;
          const gate = passesDatosPeruIdentityGate(parsed, {
            businessName: input.sessionMapsRef?.name,
            district: cleanSearchDistrict,
            address: input.sessionMapsRef?.address,
            category: input.searchCategory || corroboration.candidates.category?.value,
          });
          if (gate.accepted) {
            matchedCompany = parsed;
            matchedGate = gate;
            checkedUrls.push(detailRes.url);
            break;
          } else {
            blockedReason = gate.reason;
            rejectedCorporateCandidates.push(gate.reason);
          }
        }
      } else {
        lastHttpStatus = searchRes.status;
        blockedReason = searchRes.reason;
      }
    }

    if (matchedCompany && matchedGate) {
      // Regla 6: Solo aceptar razón social si aprobó validación estricta de rubro + distrito/anexo + marca
      if (!corroboration.candidates.businessName) {
        corroboration.candidates.businessName = {
          value: matchedCompany.razonSocial,
          source: 'authorized_public_source',
          evidenceUrl: matchedCompany.detailUrl,
          verifiedAt: researchedAt,
          confidence: 'medium',
        };
      }
      if (!corroboration.candidates.address && matchedGate.matchedDistrictAddress) {
        corroboration.candidates.address = {
          value: matchedGate.matchedDistrictAddress,
          source: 'authorized_public_source',
          evidenceUrl: matchedCompany.detailUrl,
          verifiedAt: researchedAt,
          confidence: 'medium',
        };
      }
      if (
        (!corroboration.candidates.district ||
          corroboration.candidates.district.source === 'user_search_context') &&
        matchedCompany.district
      ) {
        corroboration.candidates.district = {
          value: matchedCompany.district,
          source: 'authorized_public_source',
          evidenceUrl: matchedCompany.detailUrl,
          verifiedAt: researchedAt,
          confidence: 'medium',
        };
      }
      if (
        matchedCompany.ciiuActivity &&
        (!corroboration.candidates.category ||
          corroboration.candidates.category.source === 'user_search_context')
      ) {
        corroboration.candidates.category = {
          value: matchedCompany.ciiuActivity,
          source: 'authorized_public_source',
          evidenceUrl: matchedCompany.detailUrl,
          verifiedAt: researchedAt,
          confidence: 'medium',
        };
      }

      sourceAttempts.push({
        sourceId: 'datosperu_ruc',
        sourceName: 'DatosPeru (Padrón SUNAT abierto, robots Allow: /)',
        status: 'found',
        httpStatus: lastHttpStatus,
        checkedUrl: matchedCompany.detailUrl,
        retentionPermitted: true,
        costNote: '$0 (portal público de libre consulta, máx. 3 fichas/lead)',
        detail: `${matchedGate.reason} Nota: el padrón corporativo no publica teléfonos comerciales.`,
      });
    } else {
      sourceAttempts.push({
        sourceId: 'datosperu_ruc',
        sourceName: 'DatosPeru (Padrón SUNAT abierto, robots Allow: /)',
        status:
          blockedReason && lastHttpStatus && lastHttpStatus >= 400
            ? 'blocked_or_restricted'
            : 'not_found',
        httpStatus: lastHttpStatus,
        checkedUrl: lastCheckedUrl,
        retentionPermitted: true,
        costNote: '$0',
        detail:
          rejectedCorporateCandidates.length > 0
            ? `Homónimos rechazados sin sustituir nombre original: ${rejectedCorporateCandidates.join(' | ')}`
            : blockedReason ||
              'No se halló razón social coincidente por rubro/CIIU, marca y distrito en el padrón corporativo.',
      });
    }
  } else {
    sourceAttempts.push({
      sourceId: 'datosperu_ruc',
      sourceName: 'DatosPeru (Padrón SUNAT abierto)',
      status: 'skipped',
      httpStatus: null,
      checkedUrl: null,
      retentionPermitted: true,
      costNote: '$0',
      detail: 'Nombre comercial y dirección ya cubiertos o sin término suficiente de consulta.',
    });
  }

  // 4. Adaptador Evidencia Legítima del Usuario + Gemini opcional (strictly verbatim evidence only)
  const evidenceText = (input.userProvidedEvidenceText || '').trim();
  let usedGemini = false;

  if (evidenceText.length > 0) {
    const htmlWrapped = `<p>${decodeHtmlEntities(evidenceText)}</p>`;
    const parsedPhones = extractPeruvianPhonesFromHtml(htmlWrapped);
    registerPhones(parsedPhones, 'captura_evidencia_usuario');

    if (!corroboration.candidates.phone && parsedPhones[0]) {
      corroboration.candidates.phone = {
        value: parsedPhones[0].formatted,
        source: 'user_manual_entry',
        evidenceUrl: null,
        verifiedAt: researchedAt,
        confidence: 'high',
      };
      corroboration.candidates.phoneType = {
        value: parsedPhones[0].lineType,
        source: 'user_manual_entry',
        evidenceUrl: null,
        verifiedAt: researchedAt,
        confidence: 'high',
      };
    }

    const parsedEmail = extractFirstValidEmail(htmlWrapped);
    if (!corroboration.candidates.email && parsedEmail) {
      corroboration.candidates.email = {
        value: parsedEmail,
        source: 'user_manual_entry',
        evidenceUrl: null,
        verifiedAt: researchedAt,
        confidence: 'high',
      };
    }

    const parsedAddr = extractStreetAddressFromText(evidenceText);
    if (!corroboration.candidates.address && parsedAddr) {
      corroboration.candidates.address = {
        value: parsedAddr,
        source: 'user_manual_entry',
        evidenceUrl: null,
        verifiedAt: researchedAt,
        confidence: 'high',
      };
    }

    const parsedDistrict = detectDistrictInText(evidenceText);
    if (
      parsedDistrict &&
      (!corroboration.candidates.district ||
        corroboration.candidates.district.source === 'user_search_context')
    ) {
      corroboration.candidates.district = {
        value: parsedDistrict,
        source: 'user_manual_entry',
        evidenceUrl: null,
        verifiedAt: researchedAt,
        confidence: 'high',
      };
    }

    const explicitNameMatch = evidenceText.match(
      /(?:raz[oó]n\s+social|nombre(?:\s+comercial)?|empresa)\s*:\s*([^\n|;]{3,100})/i
    );
    if (!corroboration.candidates.businessName && explicitNameMatch) {
      corroboration.candidates.businessName = {
        value: explicitNameMatch[1].trim(),
        source: 'user_manual_entry',
        evidenceUrl: null,
        verifiedAt: researchedAt,
        confidence: 'high',
      };
    }

    const missingAfterRegex: string[] = [];
    if (!corroboration.candidates.businessName) missingAfterRegex.push('nombre comercial');
    if (!corroboration.candidates.phone) missingAfterRegex.push('teléfono');
    if (!corroboration.candidates.address) missingAfterRegex.push('dirección');
    if (!corroboration.candidates.email) missingAfterRegex.push('correo');

    const geminiKey = deps?.geminiApiKey ?? process.env.GEMINI_API_KEY ?? '';
    if (
      input.allowGeminiEvidenceAnalysis &&
      geminiKey &&
      evidenceText.length >= 15 &&
      missingAfterRegex.length > 0
    ) {
      try {
        const aiExtracted = await analyzeUserEvidenceWithGeminiSafe(
          evidenceText,
          missingAfterRegex,
          geminiKey
        );
        usedGemini = true;
        if (aiExtracted) {
          if (!corroboration.candidates.businessName && aiExtracted.businessName) {
            corroboration.candidates.businessName = {
              value: aiExtracted.businessName,
              source: 'user_manual_entry',
              evidenceUrl: null,
              verifiedAt: researchedAt,
              confidence: 'medium',
            };
          }
          if (aiExtracted.phone) {
            const p = analyzePeruvianPhone(aiExtracted.phone);
            if (p.isValidFormat && p.e164 && p.formatted) {
              registerPhones(
                [{ formatted: p.formatted, e164: p.e164, lineType: p.lineType }],
                'evidencia_usuario_gemini'
              );
              if (!corroboration.candidates.phone) {
                corroboration.candidates.phone = {
                  value: p.formatted,
                  source: 'user_manual_entry',
                  evidenceUrl: null,
                  verifiedAt: researchedAt,
                  confidence: 'medium',
                };
                corroboration.candidates.phoneType = {
                  value: p.lineType,
                  source: 'user_manual_entry',
                  evidenceUrl: null,
                  verifiedAt: researchedAt,
                  confidence: 'medium',
                };
              }
            }
          }
          if (!corroboration.candidates.address && aiExtracted.address) {
            corroboration.candidates.address = {
              value: aiExtracted.address,
              source: 'user_manual_entry',
              evidenceUrl: null,
              verifiedAt: researchedAt,
              confidence: 'medium',
            };
          }
          if (!corroboration.candidates.email && aiExtracted.email) {
            corroboration.candidates.email = {
              value: aiExtracted.email,
              source: 'user_manual_entry',
              evidenceUrl: null,
              verifiedAt: researchedAt,
              confidence: 'medium',
            };
          }
        }
      } catch {
        // Error no bloqueante de Gemini; se conserva extracción determinística
      }
    }

    const foundFromEvidence = [
      corroboration.candidates.businessName?.source === 'user_manual_entry' ? 'nombre' : null,
      corroboration.candidates.phone?.source === 'user_manual_entry' ? 'teléfono' : null,
      corroboration.candidates.address?.source === 'user_manual_entry' ? 'dirección' : null,
      corroboration.candidates.email?.source === 'user_manual_entry' ? 'correo' : null,
    ].filter(Boolean);

    sourceAttempts.push({
      sourceId: 'user_evidence_gemini',
      sourceName: usedGemini
        ? 'Evidencia provista por usuario + Gemini (guardia literal)'
        : 'Evidencia provista por usuario (parser determinístico)',
      status: foundFromEvidence.length > 0 ? 'found' : 'not_found',
      httpStatus: null,
      checkedUrl: null,
      retentionPermitted: true,
      costNote: usedGemini ? '1 llamada Gemini estándar (sin Search Grounding)' : '$0',
      detail:
        foundFromEvidence.length > 0
          ? `Extraído literalmente de la evidencia del usuario: ${foundFromEvidence.join(', ')}.`
          : 'El texto provisto no contenía campos comerciales válidos adicionales.',
    });
  } else {
    sourceAttempts.push({
      sourceId: 'user_evidence_gemini',
      sourceName: 'Evidencia legítima del usuario',
      status: 'skipped',
      httpStatus: null,
      checkedUrl: null,
      retentionPermitted: true,
      costNote: '$0',
      detail: 'No se ingresó texto/evidencia adicional del usuario.',
    });
  }

  // 5. Comparación multi-señal e identificación de contradicciones o sucursales
  const comparison = compareIdentitySignals({
    candidates: corroboration.candidates,
    allIndependentPhones: allPhones,
    sessionMapsRef: input.sessionMapsRef,
    searchDistrict: cleanSearchDistrict,
    searchCategory: input.searchCategory,
    rejectedCorporateCandidates,
  });

  // Si un sitio multi-sucursal contiene varios teléfonos y uno coincide con la sede consultada, usarlo como candidato principal
  if (comparison.matchedMapsPhone && corroboration.candidates.phone) {
    corroboration.candidates.phone = {
      ...corroboration.candidates.phone,
      value: comparison.matchedMapsPhone.formatted,
      evidenceUrl: comparison.matchedMapsPhone.evidenceUrl,
      confidence: 'high',
    };
    corroboration.candidates.phoneType = {
      ...corroboration.candidates.phoneType,
      value: comparison.matchedMapsPhone.lineType,
      evidenceUrl: comparison.matchedMapsPhone.evidenceUrl,
      confidence: 'high',
      source: corroboration.candidates.phone.source,
      verifiedAt: researchedAt,
    };
  }

  // Guardia Crítica Caso D: si hay contradicción telefónica, bloquear auto-relleno del teléfono
  if (comparison.hasPhoneContradiction) {
    corroboration.candidates.phone = null;
    corroboration.candidates.phoneType = null;
  }

  // 6. Clasificación estricta de los 4 estados para cada campo
  const classifyField = (
    key: ResearchableFieldKey,
    candidate: CorroboratedFieldCandidate<string> | null,
    mapsValueRaw?: string | null,
    isContradictory?: boolean
  ): FieldResearchClassification => {
    const mapsVal = (mapsValueRaw || '').trim() || null;

    if (isContradictory) {
      return {
        field: key,
        label: FIELD_LABELS[key],
        status: 'contradictory',
        independentValue: null,
        mapsSessionValue: mapsVal,
        source: 'none',
        sourceLabel: 'Conflicto entre fuentes',
        evidenceUrl: null,
        reason:
          comparison.contradictionAlerts[0] ||
          'Contradicción detectada entre fuente independiente y sesión Google Maps.',
      };
    }

    if (candidate && candidate.value.trim() && candidate.source !== 'none') {
      return {
        field: key,
        label: FIELD_LABELS[key],
        status: 'corroborated_persistable',
        independentValue: candidate.value.trim(),
        mapsSessionValue: mapsVal,
        source: candidate.source,
        sourceLabel: formatIndependentSourceLabel(candidate.source),
        evidenceUrl: candidate.evidenceUrl,
        reason: candidate.evidenceUrl
          ? `Corroborado desde fuente independiente (${candidate.evidenceUrl}).`
          : `Persistible desde ${formatIndependentSourceLabel(candidate.source)}.`,
      };
    }

    if (mapsVal) {
      return {
        field: key,
        label: FIELD_LABELS[key],
        status: 'maps_session_only',
        independentValue: null,
        mapsSessionValue: mapsVal,
        source: 'none',
        sourceLabel: 'Solo sesión Google Maps (no persistible)',
        evidenceUrl: null,
        reason:
          'Visible únicamente en la sesión actual de Google Maps; no existe fuente independiente corroborada para copiarlo a Firestore.',
      };
    }

    return {
      field: key,
      label: FIELD_LABELS[key],
      status: 'not_found',
      independentValue: null,
      mapsSessionValue: null,
      source: 'none',
      sourceLabel: 'Sin fuente independiente',
      evidenceUrl: null,
      reason: 'No encontrado en fuentes independientes ni en Google Maps.',
    };
  };

  const nameConflict = comparison.identityMatch.conflictingSignals.includes('name');
  const districtConflict = comparison.identityMatch.conflictingSignals.includes('district');
  const categoryConflict = comparison.identityMatch.conflictingSignals.includes('category');

  const fieldClassifications: Record<ResearchableFieldKey, FieldResearchClassification> = {
    businessName: classifyField(
      'businessName',
      nameConflict ? null : corroboration.candidates.businessName,
      input.sessionMapsRef?.name,
      nameConflict
    ),
    phone: classifyField(
      'phone',
      corroboration.candidates.phone,
      input.sessionMapsRef?.phone,
      comparison.hasPhoneContradiction
    ),
    address: classifyField(
      'address',
      corroboration.candidates.address,
      input.sessionMapsRef?.address
    ),
    district: classifyField(
      'district',
      districtConflict ? null : corroboration.candidates.district,
      cleanSearchDistrict,
      districtConflict
    ),
    website: classifyField(
      'website',
      corroboration.candidates.website,
      input.sessionMapsRef?.website
    ),
    email: classifyField('email', corroboration.candidates.email, null),
    category: classifyField(
      'category',
      categoryConflict ? null : corroboration.candidates.category,
      input.searchCategory,
      categoryConflict
    ),
  };

  if (nameConflict) {
    corroboration.candidates.businessName = null;
  }
  if (districtConflict) {
    corroboration.candidates.district = null;
  }
  if (categoryConflict) {
    corroboration.candidates.category = null;
  }

  const missingPersistableFields: string[] = [];
  if (fieldClassifications.businessName.status !== 'corroborated_persistable') {
    missingPersistableFields.push('Nombre comercial independiente');
  }
  if (fieldClassifications.phone.status !== 'corroborated_persistable') {
    missingPersistableFields.push(
      fieldClassifications.phone.status === 'contradictory'
        ? 'Teléfono (resolver contradicción entre fuentes)'
        : 'Teléfono independiente'
    );
  }
  if (fieldClassifications.address.status !== 'corroborated_persistable') {
    missingPersistableFields.push('Dirección exacta independiente');
  }
  if (fieldClassifications.website.status !== 'corroborated_persistable') {
    missingPersistableFields.push('Sitio web oficial o confirmación manual sin web');
  }

  const hasContradictions =
    comparison.hasPhoneContradiction ||
    comparison.contradictionAlerts.length > 0;

  const identityConfirmedOrPartial =
    comparison.identityMatch.overallConfidence === 'high' ||
    comparison.identityMatch.overallConfidence === 'medium';

  // Ficha completa lista requiere: identidad confirmada + sin contradicciones + nombre + teléfono + (dirección o distrito) + web verificada
  const hasCoreIdentity =
    identityConfirmedOrPartial &&
    fieldClassifications.businessName.status === 'corroborated_persistable' &&
    fieldClassifications.phone.status === 'corroborated_persistable' &&
    (fieldClassifications.address.status === 'corroborated_persistable' ||
      fieldClassifications.district.status === 'corroborated_persistable') &&
    fieldClassifications.website.status === 'corroborated_persistable';

  const canPersistCompleteCard = !hasContradictions && hasCoreIdentity;
  const recommendedQueue: MissingDataResearchResult['recommendedQueue'] =
    canPersistCompleteCard ? 'complete_ready' : 'research_queue';

  const coreCount = [
    Boolean(corroboration.candidates.businessName),
    Boolean(corroboration.candidates.phone),
    Boolean(corroboration.candidates.address || corroboration.candidates.district),
    Boolean(corroboration.candidates.website),
  ].filter(Boolean).length;
  corroboration.completeness =
    canPersistCompleteCard ? 'complete' : coreCount >= 1 ? 'partial' : 'insufficient';

  const corroboratedFieldsList = (Object.values(fieldClassifications) as FieldResearchClassification[])
    .filter((f) => f.status === 'corroborated_persistable')
    .map((f) => f.label);

  const summary = hasContradictions
    ? `CONFLICTO DE IDENTIDAD: ${comparison.contradictionAlerts[0]} Derivado a cola de investigación.`
    : canPersistCompleteCard
    ? `Ficha comercial persistible corroborada (${corroboratedFieldsList.join(', ')}) con 0 llamadas extra a Google Places.`
    : comparison.identityMatch.overallConfidence === 'unconfirmed'
    ? `IDENTIDAD NO CONFIRMADA${
        rejectedCorporateCandidates.length > 0
          ? ` (${rejectedCorporateCandidates.length} candidato(s) empresarial(es) rechazado(s) por rubro/distrito; nunca se sustituye el nombre original)`
          : ''
      }. Permanece en PENDIENTE DE VERIFICACIÓN sin copiar campos de Google Maps.`
    : `Información independiente insuficiente (${corroboratedFieldsList.length} campo(s) persistible(s): ${corroboratedFieldsList.join(', ') || 'ninguno'}). Permanece en PENDIENTE DE VERIFICACIÓN sin copiar campos de Google Maps.`;

  corroboration.summary = summary;

  return {
    placeId: input.placeId,
    needsIndependentData: !canPersistCompleteCard,
    canPersistCompleteCard,
    hasContradictions,
    recommendedQueue,
    missingPersistableFields,
    contradictionAlerts: comparison.contradictionAlerts,
    identityMatch: comparison.identityMatch,
    fieldClassifications,
    sourceAttempts,
    corroboration: {
      placeId: corroboration.placeId,
      checkedUrls: Array.from(new Set(checkedUrls)),
      websiteStatus: corroboration.websiteStatus,
      completeness: corroboration.completeness,
      summary,
      candidates: corroboration.candidates,
    },
    manualReviewLinks: buildManualReviewLinks(input),
    usedGemini,
    summary,
    researchedAt,
  };
}

export async function researchMissingLeadsBatch(
  inputs: MissingDataResearchItemInput[],
  deps?: MissingDataResearchDependencies
): Promise<MissingDataResearchResult[]> {
  const limited = inputs.slice(0, 10);
  const results: MissingDataResearchResult[] = [];
  for (const item of limited) {
    results.push(await researchMissingLeadData(item, deps));
  }
  return results;
}
