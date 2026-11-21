import ExcelJS from 'exceljs';
import {
  TemporaryQueueEntry,
} from '../types';
import { analyzePeruvianPhone } from './peruPhone';
import { formatPhoneLineTypeLabel } from './followupHydration';
import { getTemporaryQueueOutcomeMeta } from './temporaryQueue';

export interface TemporaryQueueExcelRow {
  businessName: string;
  phone: string;
  phoneType: string;
  address: string;
  district: string;
  category: string;
  website: string;
  websiteStatus: string;
  placeId: string;
  mapsPlaceIdLink: string;
  priority: string;
  scoresSummary: string;
  outcomeLabel: string;
  followUpDate: string;
  notes: string;
  addedAt: string;
  provenanceSummary: string;
  missingOrLimitation: string;
  hasMapsOnlyRestrictedData: boolean;
  hasAnyIndependentCommercialData: boolean;
}

export interface TemporaryQueueExcelExportResult {
  fileName: string;
  scope: 'all' | 'selected';
  totalQueueCount: number;
  exportedCount: number;
  independentFieldsRowsCount: number;
  mapsRestrictedRowsCount: number;
  buffer: Uint8Array;
  rows: TemporaryQueueExcelRow[];
}

function getPriorityLabel(priority?: 'alta' | 'normal' | 'baja'): string {
  if (priority === 'alta') return 'Alta';
  if (priority === 'baja') return 'Baja';
  return 'Normal';
}

function resolveWebsiteStatusLabel(entry: TemporaryQueueEntry): string {
  if (entry.independentData.confirmedNoWebsite) {
    return 'Sin web propia confirmada';
  }
  const hasIndependentSite =
    entry.independentData.provenanceConfirmed &&
    Boolean(entry.independentData.independentWebsite.trim());
  if (hasIndependentSite) {
    if (entry.lead.websiteProbe.provenance === 'independent_http') {
      return entry.lead.websiteProbe.summary;
    }
    return 'Web independiente registrada';
  }
  if (entry.lead.websiteProbe.provenance === 'independent_http') {
    return entry.lead.websiteProbe.summary;
  }
  if (entry.lead.websiteProbe.status === 'unregistered') {
    return 'Sin web registrada en búsqueda';
  }
  return 'Pendiente verificación HTTP independiente';
}

function buildPlaceIdMapsLink(placeId: string): string {
  return `https://www.google.com/maps/search/?api=1&query=Google+Maps&query_place_id=${encodeURIComponent(
    placeId
  )}`;
}

/**
 * Construye filas planas a partir de TemporaryQueueEntry en RAM con CERO llamadas externas.
 * Cumple estricto cumplimiento de Google Maps Platform ToS (§3.2.3 Anti-Export / No Caching):
 * - Place IDs, enlaces query_place_id, notas propias, resultados, fechas, prioridad, puntajes WEBNEX
 *   y contexto de búsqueda propio se exportan directamente.
 * - Nombre comercial, teléfono, dirección y web se exportan ÚNICAMENTE si provienen de fuente
 *   independiente/propia confirmada (`provenanceConfirmed === true`), sin copiar jamás campos
 *   restringidos de Google Maps ni alterar artificialmente su procedencia.
 * - Si un campo falta o está restringido por §3.2.3, se deja vacío y se documenta explícitamente.
 */
export function buildTemporaryQueueExcelRows(
  entries: TemporaryQueueEntry[]
): TemporaryQueueExcelRow[] {
  return entries.map((entry) => {
    const isProvenanceConfirmed = Boolean(entry.independentData.provenanceConfirmed);

    const businessName = isProvenanceConfirmed
      ? (entry.independentData.independentBusinessName || '').trim()
      : '';
    const phone = isProvenanceConfirmed
      ? (entry.independentData.independentPhone || '').trim()
      : '';
    const address = isProvenanceConfirmed
      ? (entry.independentData.independentAddress || '').trim()
      : '';
    const website = isProvenanceConfirmed
      ? (entry.independentData.independentWebsite || '').trim()
      : '';

    const phoneType = phone
      ? formatPhoneLineTypeLabel(analyzePeruvianPhone(phone, 'independently_corroborated').lineType)
      : '';

    const district = (entry.independentData.district || entry.searchDistrict || '').trim();
    const category = (entry.independentData.independentCategory || entry.searchCategory || '').trim();
    const websiteStatus = resolveWebsiteStatusLabel(entry);
    const placeId = entry.placeId;
    const mapsPlaceIdLink = buildPlaceIdMapsLink(placeId);
    const priority = getPriorityLabel(entry.priorityLabel);
    const scoresSummary = `Digital: ${entry.lead.digitalScore.score}/100 | Contact.: ${entry.lead.contactabilityScore.score}/100 | Confianza: ${entry.lead.trustScore.score}/100`;
    const outcomeLabel = getTemporaryQueueOutcomeMeta(entry.outcome).label;
    const followUpDate = (entry.followUpDate || '').trim();
    const notes = (entry.notes || '').trim();
    const addedAt = entry.addedAt;

    const hasSessionMapsCommercialData =
      entry.mapsSessionAvailable !== false &&
      Boolean(
        entry.lead.name?.trim() ||
          (entry.lead.phone &&
            entry.lead.phone !== 'Sin teléfono' &&
            !entry.lead.phone.startsWith('No disponible tras reinicio')) ||
          entry.lead.address?.trim() ||
          entry.lead.website?.trim()
      );

    const hasMapsOnlyRestrictedData = !isProvenanceConfirmed && hasSessionMapsCommercialData;
    const hasAnyIndependentCommercialData = Boolean(
      businessName || phone || address || website
    );

    const missingParts: string[] = [];
    if (!businessName) missingParts.push('Falta nombre comercial propio');
    if (!phone) missingParts.push('Falta teléfono propio');
    if (!address) missingParts.push('Falta dirección propia');
    if (!website && !entry.independentData.confirmedNoWebsite) {
      missingParts.push('Falta sitio web');
    }
    if (hasMapsOnlyRestrictedData) {
      missingParts.push(
        'Campos de Google Maps en sesión omitidos por restricción ToS §3.2.3 (sin fuente independiente confirmada)'
      );
    }

    const provenanceSummary = isProvenanceConfirmed
      ? `Fuente independiente/propia (${
          entry.independentData.independentDataProvenance?.trim() || 'captura_manual_webnex'
        })`
      : hasMapsOnlyRestrictedData
      ? 'Solo Place ID + gestión WEBNEX (datos de Maps restringidos por ToS §3.2.3)'
      : 'Solo Place ID + gestión WEBNEX';

    return {
      businessName,
      phone,
      phoneType,
      address,
      district,
      category,
      website,
      websiteStatus,
      placeId,
      mapsPlaceIdLink,
      priority,
      scoresSummary,
      outcomeLabel,
      followUpDate,
      notes,
      addedAt,
      provenanceSummary,
      missingOrLimitation: missingParts.length > 0 ? missingParts.join(' · ') : 'Completo (fuente propia)',
      hasMapsOnlyRestrictedData,
      hasAnyIndependentCommercialData,
    };
  });
}

function getWorkbookConstructor(): typeof ExcelJS.Workbook {
  const modAny = ExcelJS as unknown as {
    Workbook?: typeof ExcelJS.Workbook;
    default?: { Workbook?: typeof ExcelJS.Workbook };
  };
  const globalAny = (globalThis as unknown as {
    ExcelJS?: { Workbook?: typeof ExcelJS.Workbook };
  })?.ExcelJS;
  const Ctor = modAny?.Workbook || modAny?.default?.Workbook || globalAny?.Workbook;
  if (!Ctor) {
    throw new Error('No se pudo inicializar ExcelJS Workbook en este entorno.');
  }
  return Ctor;
}

/**
 * Genera el binario .XLSX válido en memoria usando ExcelJS con cero llamadas a APIs externas.
 * Preserva explícitamente teléfonos con prefijo +51 como TEXTO (`numFmt = '@'`).
 */
export async function generateTemporaryQueueExcelWorkbookBuffer(
  entries: TemporaryQueueEntry[],
  options?: {
    scope?: 'all' | 'selected';
    totalQueueCount?: number;
    exportedAtIso?: string;
  }
): Promise<TemporaryQueueExcelExportResult> {
  const scope: 'all' | 'selected' = options?.scope === 'selected' ? 'selected' : 'all';
  const totalQueueCount = options?.totalQueueCount ?? entries.length;
  const exportedAtIso = options?.exportedAtIso || new Date().toISOString();
  const rows = buildTemporaryQueueExcelRows(entries);

  const WorkbookCtor = getWorkbookConstructor();
  const workbook = new WorkbookCtor();
  workbook.creator = 'WEBNEX SYSTEMS — Peru Lead Extractor Pro';
  workbook.created = new Date(exportedAtIso);
  workbook.modified = new Date(exportedAtIso);

  const sheet = workbook.addWorksheet('Cola_Temporal_WEBNEX', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const headers = [
    'Nombre comercial',
    'Teléfono completo',
    'Tipo de teléfono',
    'Dirección',
    'Distrito',
    'Categoría',
    'Sitio web registrado',
    'Estado web',
    'Place ID',
    'Enlace Google Maps',
    'Prioridad comercial',
    'Puntajes WEBNEX',
    'Resultado de contacto',
    'Fecha de seguimiento',
    'Notas',
    'Fecha de incorporación',
    'Procedencia de datos',
    'Datos faltantes / Limitación contractual',
  ];

  sheet.columns = [
    { key: 'businessName', width: 32 },
    { key: 'phone', width: 20 },
    { key: 'phoneType', width: 20 },
    { key: 'address', width: 34 },
    { key: 'district', width: 18 },
    { key: 'category', width: 20 },
    { key: 'website', width: 30 },
    { key: 'websiteStatus', width: 28 },
    { key: 'placeId', width: 30 },
    { key: 'mapsPlaceIdLink', width: 44 },
    { key: 'priority', width: 16 },
    { key: 'scoresSummary', width: 42 },
    { key: 'outcomeLabel', width: 22 },
    { key: 'followUpDate', width: 18 },
    { key: 'notes', width: 40 },
    { key: 'addedAt', width: 24 },
    { key: 'provenanceSummary', width: 38 },
    { key: 'missingOrLimitation', width: 52 },
  ];

  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF581C87' },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  headerRow.height = 28;

  for (const row of rows) {
    const excelRow = sheet.addRow([
      row.businessName,
      row.phone,
      row.phoneType,
      row.address,
      row.district,
      row.category,
      row.website,
      row.websiteStatus,
      row.placeId,
      row.mapsPlaceIdLink,
      row.priority,
      row.scoresSummary,
      row.outcomeLabel,
      row.followUpDate,
      row.notes,
      row.addedAt,
      row.provenanceSummary,
      row.missingOrLimitation,
    ]);

    // Columna 2 (Teléfono completo): forzar explícitamente formato TEXTO '@' para preservar "+51" y ceros
    const phoneCell = excelRow.getCell(2);
    phoneCell.value = row.phone;
    phoneCell.numFmt = '@';

    // Columna 9 (Place ID) y Columna 14 (Fecha seguimiento) también como texto literal
    excelRow.getCell(9).numFmt = '@';
    excelRow.getCell(14).numFmt = '@';

    excelRow.alignment = { vertical: 'top', wrapText: true };
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, rows.length + 1), column: headers.length },
  };

  // Hoja 2: Transparencia y Auditoría Contractual Google Maps Platform
  const complianceSheet = workbook.addWorksheet('Aviso_Compliance_GMP');
  complianceSheet.columns = [{ width: 38 }, { width: 90 }];
  const titleRow = complianceSheet.addRow([
    'Auditoría de Cumplimiento Contractual — Google Maps Platform',
    'Detalle de Exportación de Cola Temporal (WEBNEX SYSTEMS)',
  ]);
  titleRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  titleRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };

  const independentFieldsRowsCount = rows.filter((r) => r.hasAnyIndependentCommercialData).length;
  const mapsRestrictedRowsCount = rows.filter((r) => r.hasMapsOnlyRestrictedData).length;

  const auditRows: [string, string][] = [
    ['Fecha de exportación', exportedAtIso],
    ['Alcance', scope === 'all' ? 'Cola completa (sin filtros ni paginación)' : 'Solo prospectos seleccionados'],
    ['Total en cola temporal', String(totalQueueCount)],
    ['Filas exportadas en este archivo', String(rows.length)],
    ['Filas con datos comerciales independientes', String(independentFieldsRowsCount)],
    ['Filas con campos Google Maps omitidos (§3.2.3)', String(mapsRestrictedRowsCount)],
    [
      'Base contractual Google Maps Platform',
      'ToS Sección 3.2.3(a)-(b) prohíbe exportar, extraer o almacenar en bases externas contenido de Google Maps (nombres, teléfonos, direcciones, webs o reseñas obtenidas vía Places API) sin fuente independiente. Service Specific Terms autoriza almacenar y referenciar Place IDs.',
    ],
    [
      'Política aplicada en este archivo',
      'Se exportan los Place IDs, enlaces query_place_id, notas propias, resultados, fechas, prioridad, puntajes WEBNEX, distrito/categoría de búsqueda y únicamente los datos comerciales que cuentan con procedencia independiente/propia confirmada. Ningún dato exclusivo de Google Maps fue copiado o re-etiquetado.',
    ],
  ];

  for (const [k, v] of auditRows) {
    const r = complianceSheet.addRow([k, v]);
    r.getCell(1).font = { bold: true };
    r.alignment = { vertical: 'top', wrapText: true };
  }

  const rawBuffer = await workbook.xlsx.writeBuffer();
  const buffer = rawBuffer instanceof Uint8Array ? rawBuffer : new Uint8Array(rawBuffer);
  const datePart = exportedAtIso.slice(0, 10);
  const suffix = scope === 'selected' ? 'seleccionados' : 'completa';
  const fileName = `webnex_cola_temporal_${suffix}_${datePart}.xlsx`;

  return {
    fileName,
    scope,
    totalQueueCount,
    exportedCount: rows.length,
    independentFieldsRowsCount,
    mapsRestrictedRowsCount,
    buffer,
    rows,
  };
}

/**
 * Dispara la descarga inmediata en navegador del archivo .XLSX sin modificar ni limpiar la cola temporal
 * y sin efectuar llamadas a Places, Gemini, Firestore ni HTTP.
 */
export async function exportTemporaryQueueToExcel(
  queue: TemporaryQueueEntry[],
  options?: { scope?: 'all' | 'selected' }
): Promise<TemporaryQueueExcelExportResult> {
  const scope: 'all' | 'selected' = options?.scope === 'selected' ? 'selected' : 'all';
  const targetEntries =
    scope === 'selected' ? queue.filter((entry) => Boolean(entry.isSelected)) : queue;

  const result = await generateTemporaryQueueExcelWorkbookBuffer(targetEntries, {
    scope,
    totalQueueCount: queue.length,
  });

  if (typeof document !== 'undefined' && typeof URL !== 'undefined') {
    const copyBytes = new Uint8Array(result.buffer);
    const blob = new Blob([copyBytes.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return result;
}
