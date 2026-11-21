import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckSquare,
  Clock,
  CloudCheck,
  Database,
  ExternalLink,
  FileSpreadsheet,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import {
  CrmWorkspaceMode,
  TEMPORARY_QUEUE_OUTCOMES,
  TemporaryQueueEntry,
  TemporaryQueueIndependentDraft,
  TemporaryQueueOutcome,
  TemporaryQueuePriority,
  TemporaryQueueTtlHours,
} from '../types';
import {
  evaluateTemporaryEntryFourConcepts,
  filterTemporaryQueue,
  getTemporaryQueueOutcomeMeta,
  mapTemporaryOutcomeToCrmState,
} from '../utils/temporaryQueue';
import { formatPhoneLineTypeLabel } from '../utils/followupHydration';
import { evaluateFollowupCompleteness } from '../utils/fieldCompliance';
import {
  exportTemporaryQueueToExcel,
  TemporaryQueueExcelExportResult,
} from '../utils/temporaryQueueExcelExport';

interface TemporaryQueueViewProps {
  queue: TemporaryQueueEntry[];
  isSignedIn: boolean;
  workspaceMode: CrmWorkspaceMode;
  onChangeWorkspaceMode: (mode: CrmWorkspaceMode) => void;
  ttlHours?: TemporaryQueueTtlHours;
  onChangeTtlHours?: (hours: TemporaryQueueTtlHours) => void;
  isSyncingPersistence?: boolean;
  restorationNotice?: string | null;
  onDismissRestorationNotice?: () => void;
  onUpdateEntry: (
    placeId: string,
    patch: Partial<{
      outcome: TemporaryQueueOutcome;
      notes: string;
      followUpDate: string;
      priorityLabel: TemporaryQueuePriority;
      isSelected: boolean;
      independentData: Partial<TemporaryQueueIndependentDraft>;
    }>
  ) => void;
  onRemoveSelected: (placeIds: string[]) => void;
  onClearAll: () => void;
  onPromoteToCrm: (entry: TemporaryQueueEntry) => Promise<string | null>;
  onGoToExplorer: () => void;
}

export const TemporaryQueueView: React.FC<TemporaryQueueViewProps> = ({
  queue,
  isSignedIn,
  workspaceMode,
  onChangeWorkspaceMode,
  ttlHours = 24,
  onChangeTtlHours,
  isSyncingPersistence = false,
  restorationNotice = null,
  onDismissRestorationNotice,
  onUpdateEntry,
  onRemoveSelected,
  onClearAll,
  onPromoteToCrm,
  onGoToExplorer,
}) => {
  const [searchText, setSearchText] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState<'all' | TemporaryQueueOutcome>('all');
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [expandedCrmPlaceId, setExpandedCrmPlaceId] = useState<string | null>(null);
  const [promotingPlaceId, setPromotingPlaceId] = useState<string | null>(null);
  const [transferFeedback, setTransferFeedback] = useState<{
    placeId: string;
    ok: boolean;
    message: string;
  } | null>(null);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [excelExportStatus, setExcelExportStatus] = useState<{
    ok: boolean;
    message: string;
    result?: TemporaryQueueExcelExportResult;
  } | null>(null);

  const filteredQueue = useMemo(
    () => filterTemporaryQueue(queue, { searchText, outcomeFilter }),
    [queue, searchText, outcomeFilter]
  );

  const outcomeCounts = useMemo(() => {
    const map = new Map<TemporaryQueueOutcome, number>();
    for (const o of TEMPORARY_QUEUE_OUTCOMES) map.set(o.value, 0);
    for (const item of queue) {
      map.set(item.outcome, (map.get(item.outcome) || 0) + 1);
    }
    return map;
  }, [queue]);

  const allFilteredSelected =
    filteredQueue.length > 0 && filteredQueue.every((item) => Boolean(item.isSelected));

  const selectedInQueueCount = useMemo(
    () => queue.filter((item) => Boolean(item.isSelected)).length,
    [queue]
  );

  const toggleOne = (entry: TemporaryQueueEntry) => {
    onUpdateEntry(entry.placeId, { isSelected: !entry.isSelected });
  };

  const handleToggleSelectAll = () => {
    const nextValue = !allFilteredSelected;
    for (const item of filteredQueue) {
      if (Boolean(item.isSelected) !== nextValue) {
        onUpdateEntry(item.placeId, { isSelected: nextValue });
      }
    }
  };

  const handleDeleteSelected = () => {
    const ids = queue.filter((item) => Boolean(item.isSelected)).map((item) => item.placeId);
    if (ids.length === 0) return;
    onRemoveSelected(ids);
  };

  const handleConfirmClearAll = () => {
    onClearAll();
    setConfirmClearOpen(false);
  };

  const handleExportExcel = async (scope: 'all' | 'selected') => {
    if (queue.length === 0) return;
    if (scope === 'selected' && selectedInQueueCount === 0) return;
    setIsExportingExcel(true);
    setExcelExportStatus(null);
    try {
      const result = await exportTemporaryQueueToExcel(queue, { scope });
      const coincidenceMsg =
        scope === 'all'
          ? `Coincide con los ${result.totalQueueCount} prospecto(s) de la cola.`
          : `Selección exportada: ${result.exportedCount} de ${result.totalQueueCount} prospecto(s) de la cola.`;
      const complianceDetail =
        result.mapsRestrictedRowsCount > 0
          ? ` ${result.mapsRestrictedRowsCount} fila(s) omitieron campos exclusivos de sesión Google Maps sin fuente independiente (ToS §3.2.3).`
          : '';
      setExcelExportStatus({
        ok: true,
        result,
        message: `Excel (.xlsx) descargado: ${result.exportedCount} fila(s) exportadas (${result.fileName}). ${coincidenceMsg}${complianceDetail} Cola intacta · 0 consultas API.`,
      });
    } catch (err: any) {
      setExcelExportStatus({
        ok: false,
        message: err?.message || 'No se pudo generar el archivo .xlsx.',
      });
    } finally {
      setIsExportingExcel(false);
    }
  };

  const handlePromoteEntry = async (entry: TemporaryQueueEntry) => {
    const hasOwnCommercialName = entry.independentData.independentBusinessName.trim().length > 0;
    const hasOwnPhone = entry.independentData.independentPhone.trim().length > 0;
    const hasOwnAddress = entry.independentData.independentAddress.trim().length > 0;
    const hasOwnWeb =
      entry.independentData.independentWebsite.trim().length > 0 ||
      entry.independentData.confirmedNoWebsite;

    if (!hasOwnCommercialName && !hasOwnPhone && !hasOwnAddress && !hasOwnWeb) {
      setTransferFeedback({
        placeId: entry.placeId,
        ok: false,
        message:
          'Ingresa al menos un dato comercial propio corroborado (nombre, teléfono, dirección o web/sin web) antes de trasladar al CRM definitivo.',
      });
      return;
    }

    if (!entry.independentData.provenanceConfirmed) {
      setTransferFeedback({
        placeId: entry.placeId,
        ok: false,
        message:
          'Confirma la casilla de procedencia independiente antes de persistir en Firestore.',
      });
      return;
    }

    const meta = getTemporaryQueueOutcomeMeta(entry.outcome);
    if (
      meta.requiresLegalAuthorizationForCrm &&
      entry.independentData.legalBasis.trim().length < 8
    ) {
      setTransferFeedback({
        placeId: entry.placeId,
        ok: false,
        message: `El resultado "${meta.label}" exige una base legal o consentimiento documentado (mínimo 8 caracteres) para pasar al CRM definitivo.`,
      });
      return;
    }

    setPromotingPlaceId(entry.placeId);
    setTransferFeedback(null);
    try {
      const savedId = await onPromoteToCrm(entry);
      setTransferFeedback({
        placeId: entry.placeId,
        ok: true,
        message: `Guardado en CRM definitivo (${workspaceMode === 'sandbox' ? 'Sandbox' : 'Producción'})${
          savedId ? ` · ID: ${savedId}` : ''
        }.`,
      });
    } catch (err: any) {
      setTransferFeedback({
        placeId: entry.placeId,
        ok: false,
        message: err?.message || 'No se pudo trasladar la ficha al CRM definitivo.',
      });
    } finally {
      setPromotingPlaceId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Advertencia discreta de sesión + explicación transparente de respaldo 12h/24h */}
      <div className="bg-amber-50/80 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-950 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-800 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-semibold">
              Cola Temporal de Sesión + Recuperación Segura ({ttlHours}h · 0 llamadas Places Details)
            </div>
            <p className="text-[11px] leading-relaxed opacity-90">
              {isSignedIn
                ? `Tu trabajo permitido (Place IDs, notas propias, resultados, fechas, prioridades y datos comerciales con procedencia independiente confirmada) se respalda automáticamente por ${ttlHours} horas en Firestore. Los datos sin corroboración provenientes solo de Google Places viven únicamente en memoria RAM y no se conservarán al cerrar o reiniciar la sesión.`
                : 'Inicia sesión con Google para activar el respaldo recuperable de 12h/24h de tus notas, resultados y datos propios en Firestore. Mientras tanto, los datos de Google Places viven solo en memoria RAM y no se conservarán al cerrar o reiniciar la sesión.'}{' '}
              Tener un número publicado en Google Maps <strong>no equivale a autorización de contacto</strong>.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onGoToExplorer}
          className="px-3 py-1.5 text-xs font-medium bg-white border border-amber-300 text-amber-950 rounded-lg hover:bg-amber-100/60 whitespace-nowrap shrink-0"
        >
          Volver a Explorador
        </button>
      </div>

      {restorationNotice && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl px-4 py-2.5 text-xs text-purple-950 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CloudCheck className="w-4 h-4 text-purple-700 shrink-0" />
            <span>{restorationNotice}</span>
          </div>
          {onDismissRestorationNotice && (
            <button
              type="button"
              onClick={onDismissRestorationNotice}
              className="text-[11px] underline text-purple-800 shrink-0"
            >
              Entendido
            </button>
          )}
        </div>
      )}

      {/* Barra de controles de gestión (Fase 2 + Caducidad configurable 12h / 24h) */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900">
                Cola de Trabajo Temporal ({queue.length} prospecto{queue.length === 1 ? '' : 's'})
              </h2>
              {isSignedIn && (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200">
                  <Clock className="w-3 h-3" />
                  {isSyncingPersistence
                    ? 'Sincronizando respaldo...'
                    : `Respaldo propio activo (${ttlHours}h)`}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Registra notas, resultados, fechas de seguimiento y datos propios sin depender de Places ni alterar el CRM definitivo.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onChangeTtlHours && (
              <div
                className="inline-flex items-center rounded-lg border border-slate-300 bg-slate-50 p-0.5 text-[11px]"
                title="Caducidad configurable para datos permitidos en cola temporal"
              >
                <span className="px-2 text-slate-600 font-medium">Caducidad:</span>
                {([12, 24] as TemporaryQueueTtlHours[]).map((hrs) => (
                  <button
                    key={hrs}
                    type="button"
                    onClick={() => onChangeTtlHours(hrs)}
                    className={`px-2 py-1 rounded-md font-semibold transition-colors ${
                      ttlHours === hrs
                        ? 'bg-purple-700 text-white'
                        : 'text-slate-700 hover:bg-slate-200/70'
                    }`}
                  >
                    {hrs}h
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              disabled={queue.length === 0 || isExportingExcel}
              onClick={() => handleExportExcel('all')}
              className="px-3.5 py-1.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-40 text-white rounded-lg inline-flex items-center gap-1.5 shadow-sm"
              title="Exporta todos los prospectos de la cola temporal a .xlsx en el navegador (0 llamadas API · respeta ToS §3.2.3)"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              EXPORTAR TODOS A EXCEL (.XLSX)
            </button>

            <button
              type="button"
              disabled={selectedInQueueCount === 0 || isExportingExcel}
              onClick={() => handleExportExcel('selected')}
              className="px-3 py-1.5 text-xs font-medium border border-emerald-300 bg-emerald-50 text-emerald-900 rounded-lg hover:bg-emerald-100 disabled:opacity-40 inline-flex items-center gap-1.5"
              title="Exporta únicamente los prospectos marcados en la cola temporal"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Exportar seleccionados ({selectedInQueueCount})
            </button>

            <button
              type="button"
              disabled={filteredQueue.length === 0}
              onClick={handleToggleSelectAll}
              className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 disabled:opacity-40 inline-flex items-center gap-1.5"
            >
              <CheckSquare className="w-3.5 h-3.5 text-purple-700" />
              {allFilteredSelected ? 'Deseleccionar todos' : 'Seleccionar todos'}
            </button>

            <button
              type="button"
              disabled={selectedInQueueCount === 0}
              onClick={handleDeleteSelected}
              className="px-3 py-1.5 text-xs font-medium border border-rose-300 bg-rose-50 text-rose-800 rounded-lg hover:bg-rose-100 disabled:opacity-40 inline-flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Eliminar seleccionados ({selectedInQueueCount})
            </button>

            <button
              type="button"
              disabled={queue.length === 0}
              onClick={() => setConfirmClearOpen(true)}
              className="px-3 py-1.5 text-xs font-medium border border-slate-300 text-slate-700 rounded-lg hover:bg-rose-50 hover:text-rose-800 hover:border-rose-300 disabled:opacity-40"
            >
              Limpiar toda la cola
            </button>
          </div>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[11px] text-slate-700 flex flex-col gap-1">
          <div>
            <strong>Alcance de exportación Excel (.xlsx):</strong> Exporta todos los <strong>{queue.length}</strong> prospectos de la cola sin exigir ficha 4/4, RUC ni base legal y sin gastar APIs. Incluye Place ID, enlace Maps por Place ID, notas, resultados, prioridad, puntajes WEBNEX, distrito/categoría de búsqueda y campos comerciales independientes (teléfonos <code className="font-mono-tabular">+51</code> como texto).
          </div>
          <div className="text-amber-900">
            <strong>Limitación contractual (Google Maps Platform ToS §3.2.3):</strong> Por prohibición de exportación/caché fuera de Maps, los nombres, teléfonos, direcciones o webs que existan únicamente en sesión Google Maps sin fuente independiente se dejan vacíos en el Excel y se identifican explícitamente sin alterar su procedencia.
          </div>
        </div>

        {excelExportStatus && (
          <div
            className={`rounded-lg px-3 py-2 text-xs border flex items-center justify-between gap-2 ${
              excelExportStatus.ok
                ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
                : 'bg-rose-50 border-rose-300 text-rose-900'
            }`}
          >
            <span>{excelExportStatus.message}</span>
            <button
              type="button"
              onClick={() => setExcelExportStatus(null)}
              className="text-[11px] underline shrink-0"
            >
              Cerrar
            </button>
          </div>
        )}

        {confirmClearOpen && (
          <div className="bg-rose-50 border border-rose-300 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-rose-950">
            <span>
              ¿Confirmas vaciar los <strong>{queue.length}</strong> prospectos de la cola temporal (incluyendo su respaldo temporal de {ttlHours}h)? Esto <strong>no modifica</strong> los registros del CRM definitivo.
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleConfirmClearAll}
                className="px-3 py-1.5 bg-rose-700 text-white font-semibold rounded-md hover:bg-rose-800"
              >
                Sí, vaciar cola temporal
              </button>
              <button
                type="button"
                onClick={() => setConfirmClearOpen(false)}
                className="px-3 py-1.5 bg-white border border-slate-300 rounded-md text-slate-700"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* Búsqueda por nombre o teléfono + Filtro por estado */}
        <div className="flex flex-col md:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Buscar en cola temporal por nombre comercial, teléfono o Place ID..."
              className="w-full pl-8 pr-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setOutcomeFilter('all')}
            className={`px-2.5 py-1 text-[11px] font-medium rounded-md border ${
              outcomeFilter === 'all'
                ? 'bg-purple-700 text-white border-purple-700'
                : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
            }`}
          >
            Todos ({queue.length})
          </button>
          {TEMPORARY_QUEUE_OUTCOMES.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setOutcomeFilter(opt.value)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-md border ${
                outcomeFilter === opt.value
                  ? 'bg-purple-700 text-white border-purple-700'
                  : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
              }`}
            >
              {opt.label} ({outcomeCounts.get(opt.value) || 0})
            </button>
          ))}
        </div>
      </div>

      {/* Lista de prospectos en Cola Temporal */}
      {filteredQueue.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
          <div className="text-sm font-semibold text-slate-800">
            {queue.length === 0
              ? 'Tu cola temporal de Seguimiento está vacía en esta sesión'
              : 'Ningún prospecto coincide con tu búsqueda o estado'}
          </div>
          <p className="text-xs text-slate-500 max-w-lg mx-auto">
            {queue.length === 0
              ? 'En Explorador, selecciona uno o varios establecimientos encontrados con Google Places y pulsa "Agregar a Seguimiento temporal". Sus nombres y teléfonos aparecerán aquí al instante sin gastar consultas adicionales.'
              : 'Limpia el buscador o cambia el filtro de resultado para volver a ver toda tu cola temporal.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredQueue.map((entry) => {
            const lead = entry.lead;
            const checked = Boolean(entry.isSelected);
            const outcomeMeta = getTemporaryQueueOutcomeMeta(entry.outcome);
            const fourConcepts = evaluateTemporaryEntryFourConcepts(entry);
            const isCrmExpanded = expandedCrmPlaceId === entry.placeId;
            const feedbackForRow =
              transferFeedback?.placeId === entry.placeId ? transferFeedback : null;
            const hasLiveMapsSession = entry.mapsSessionAvailable !== false && Boolean(lead.name);
            const hasIndependentName =
              entry.independentData.provenanceConfirmed &&
              Boolean(entry.independentData.independentBusinessName.trim());
            const hasIndependentPhone =
              entry.independentData.provenanceConfirmed &&
              Boolean(entry.independentData.independentPhone.trim());

            const displayTitle = hasLiveMapsSession
              ? lead.name
              : hasIndependentName
              ? entry.independentData.independentBusinessName.trim()
              : `Establecimiento (${entry.placeId})`;

            const displayPhone = hasIndependentPhone
              ? entry.independentData.independentPhone.trim()
              : hasLiveMapsSession
              ? lead.phone
              : 'No disponible tras reinicio (solo sesión Maps)';

            const crmCompleteness = evaluateFollowupCompleteness({
              independentBusinessName: entry.independentData.independentBusinessName,
              independentPhone: entry.independentData.independentPhone,
              independentAddress: entry.independentData.independentAddress,
              district: entry.independentData.district,
              independentWebsite: entry.independentData.independentWebsite,
              confirmedNoWebsite: entry.independentData.confirmedNoWebsite,
              independentEmail: entry.independentData.independentEmail,
              independentCategory: entry.independentData.independentCategory,
            });
            const crmPreview = mapTemporaryOutcomeToCrmState(
              entry.outcome,
              entry.independentData.legalBasis
            );

            return (
              <div
                key={entry.placeId}
                className={`bg-white border rounded-xl p-4 space-y-3 transition-colors ${
                  checked ? 'border-purple-400 ring-1 ring-purple-200' : 'border-slate-200'
                }`}
              >
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
                  {/* Bloque A: Referencia de sesión Google Places vs Dato Propio Recuperado */}
                  <div className="lg:col-span-6 space-y-2">
                    <div className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(entry)}
                        aria-label={`Seleccionar ${displayTitle}`}
                        className="mt-1 rounded border-slate-300 text-purple-700 focus:ring-purple-600"
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                              hasLiveMapsSession
                                ? 'bg-slate-100 border-slate-300 text-slate-700'
                                : 'bg-amber-50 border-amber-300 text-amber-900'
                            }`}
                          >
                            {hasLiveMapsSession
                              ? 'Datos temporales Google Places (sesión)'
                              : 'Restaurado (Maps ya no en RAM)'}
                          </span>
                          <span
                            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${outcomeMeta.badgeClass}`}
                          >
                            {outcomeMeta.label}
                          </span>
                          {entry.priorityLabel === 'alta' && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-rose-50 border border-rose-300 text-rose-800">
                              Prioridad alta
                            </span>
                          )}
                          {entry.promotedToCrmId && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-300 text-emerald-900">
                              En CRM Definitivo
                            </span>
                          )}
                        </div>

                        <h3 className="text-sm font-semibold text-slate-900">{displayTitle}</h3>

                        {!hasLiveMapsSession && (
                          <p className="text-[11px] text-amber-900 bg-amber-50/70 border border-amber-200 rounded px-2 py-1">
                            {hasIndependentName || hasIndependentPhone
                              ? 'Datos propios independientes restaurados desde Firestore (< 24h). Los campos exclusivos de Google Maps se liberaron al reiniciar la sesión.'
                              : 'Place ID y notas restauradas desde Firestore. Los campos temporales de Google Maps (nombre/teléfono) no se guardan sin procedencia propia y requieren nueva búsqueda si deseas refrescarlos.'}
                          </p>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-slate-700">
                          <div>
                            <span className="text-slate-500">
                              {hasIndependentPhone ? 'Teléfono propio: ' : 'Teléfono Places: '}
                            </span>
                            <strong className="font-mono-tabular text-slate-900">
                              {displayPhone}
                            </strong>{' '}
                            {hasLiveMapsSession && (
                              <span className="text-[11px] text-slate-500">
                                ({formatPhoneLineTypeLabel(lead.phoneAnalysis.lineType)})
                              </span>
                            )}
                          </div>
                          <div>
                            <span className="text-slate-500">Estado digital: </span>
                            <span className="font-medium">{lead.websiteProbe.summary}</span>
                          </div>
                          {(hasLiveMapsSession || entry.independentData.independentAddress) && (
                            <div className="sm:col-span-2">
                              <span className="text-slate-500">
                                {entry.independentData.provenanceConfirmed &&
                                entry.independentData.independentAddress
                                  ? 'Dirección propia: '
                                  : 'Dirección Places: '}
                              </span>
                              <span>
                                {entry.independentData.provenanceConfirmed &&
                                entry.independentData.independentAddress
                                  ? entry.independentData.independentAddress
                                  : lead.address}
                              </span>
                            </div>
                          )}
                          {(hasLiveMapsSession ? lead.website : entry.independentData.independentWebsite) && (
                            <div className="sm:col-span-2 truncate">
                              <span className="text-slate-500">Web registrada: </span>
                              <a
                                href={
                                  (hasLiveMapsSession
                                    ? lead.website
                                    : entry.independentData.independentWebsite
                                  ).startsWith('http')
                                    ? hasLiveMapsSession
                                      ? lead.website
                                      : entry.independentData.independentWebsite
                                    : `https://${
                                        hasLiveMapsSession
                                          ? lead.website
                                          : entry.independentData.independentWebsite
                                      }`
                                }
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-purple-700 hover:underline"
                              >
                                {hasLiveMapsSession
                                  ? lead.website
                                  : entry.independentData.independentWebsite}
                              </a>
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 font-mono-tabular pt-0.5">
                          <span>Place ID: {entry.placeId}</span>
                          <a
                            href={lead.mapsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-sans text-purple-700 hover:underline inline-flex items-center gap-1"
                          >
                            Ver en Google Maps
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      </div>
                    </div>

                    {/* FASE 5: Separación explícita de los 4 conceptos distintos */}
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px]">
                      <div>
                        <span className="text-slate-500">1. Formato telefónico: </span>
                        <strong
                          className={
                            fourConcepts.hasValidPhoneFormat ? 'text-slate-900' : 'text-slate-600'
                          }
                        >
                          {fourConcepts.phoneFormatLabel}
                        </strong>
                      </div>
                      <div>
                        <span className="text-slate-500">2. Corroboración: </span>
                        <strong
                          className={
                            fourConcepts.isPhoneIndependentlyCorroborated
                              ? 'text-emerald-800'
                              : 'text-amber-800'
                          }
                        >
                          {fourConcepts.phoneCorroborationLabel}
                        </strong>
                      </div>
                      <div>
                        <span className="text-slate-500">3. Autorización: </span>
                        <strong
                          className={
                            fourConcepts.hasContactAuthorization
                              ? 'text-emerald-800'
                              : 'text-amber-900'
                          }
                        >
                          {fourConcepts.authorizationLabel}
                        </strong>
                      </div>
                      <div>
                        <span className="text-slate-500">4. Resultado propio: </span>
                        <strong className="text-purple-900">{fourConcepts.realOutcomeLabel}</strong>
                      </div>
                    </div>
                  </div>

                  {/* Bloque B: Gestión comercial propia WEBNEX (respaldo 12h/24h si está autenticado) */}
                  <div className="lg:col-span-6 space-y-2.5 bg-purple-50/30 border border-purple-100 rounded-lg p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-purple-950">
                        Gestión comercial propia WEBNEX ({isSignedIn ? `TTL ${entry.ttlHours ?? ttlHours}h` : 'sesión'} · 0 Places)
                      </span>
                      <button
                        type="button"
                        onClick={() => onRemoveSelected([entry.placeId])}
                        className="text-[11px] text-rose-700 hover:underline inline-flex items-center gap-1"
                        title="Quitar de la cola temporal"
                      >
                        <Trash2 className="w-3 h-3" />
                        Quitar de cola
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[11px] font-medium text-slate-700 mb-1">
                          Resultado / estado
                        </label>
                        <select
                          value={entry.outcome}
                          onChange={(e) =>
                            onUpdateEntry(entry.placeId, {
                              outcome: e.target.value as TemporaryQueueOutcome,
                            })
                          }
                          className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                        >
                          {TEMPORARY_QUEUE_OUTCOMES.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[11px] font-medium text-slate-700 mb-1">
                          Fecha de seguimiento
                        </label>
                        <input
                          type="date"
                          value={entry.followUpDate || ''}
                          onChange={(e) =>
                            onUpdateEntry(entry.placeId, { followUpDate: e.target.value })
                          }
                          className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-medium text-slate-700 mb-1">
                          Prioridad propia
                        </label>
                        <select
                          value={entry.priorityLabel || 'normal'}
                          onChange={(e) =>
                            onUpdateEntry(entry.placeId, {
                              priorityLabel: e.target.value as TemporaryQueuePriority,
                            })
                          }
                          className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                        >
                          <option value="alta">Alta</option>
                          <option value="normal">Normal</option>
                          <option value="baja">Baja</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Notas comerciales propias ({isSignedIn ? `recuperables ${ttlHours}h` : 'sesión'})
                      </label>
                      <textarea
                        rows={2}
                        value={entry.notes}
                        onChange={(e) =>
                          onUpdateEntry(entry.placeId, { notes: e.target.value })
                        }
                        placeholder="Anota observaciones propias, horario, necesidad detectada o resultado..."
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                      />
                    </div>

                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedCrmPlaceId(isCrmExpanded ? null : entry.placeId)
                        }
                        className="px-3 py-1.5 text-xs font-semibold border border-emerald-300 bg-emerald-50 text-emerald-900 rounded-md hover:bg-emerald-100 inline-flex items-center justify-center gap-1.5"
                      >
                        <Database className="w-3.5 h-3.5" />
                        {isCrmExpanded
                          ? 'Ocultar datos propios / CRM'
                          : 'Datos propios / Trasladar a CRM'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Bloque C: Datos comerciales independientes (recuperables 24h si provenanceConfirmed) + Traslado opcional al CRM Definitivo Firestore */}
                {isCrmExpanded && (
                  <div className="border-t border-slate-200 pt-3 mt-1 bg-emerald-50/30 rounded-lg p-3 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-semibold text-emerald-950 flex items-center gap-1.5">
                          <ShieldAlert className="w-4 h-4 text-emerald-800 shrink-0" />
                          Datos comerciales propios persistibles ({crmCompleteness.label}) · Destino: CRM Definitivo ({workspaceMode === 'sandbox' ? 'Sandbox' : 'Producción'})
                        </div>
                        <p className="text-[11px] text-slate-600 mt-0.5">
                          Al marcar procedencia independiente, nombre y teléfono propios se conservan durante {ttlHours}h incluso tras recargar. Etapa estimada en CRM definitivo: <strong>{crmPreview.stage}</strong>.
                        </p>
                      </div>

                      <div className="inline-flex items-center gap-1.5 text-[11px] shrink-0">
                        <button
                          type="button"
                          onClick={() => onChangeWorkspaceMode('production')}
                          className={`px-2 py-1 rounded border font-medium ${
                            workspaceMode === 'production'
                              ? 'bg-purple-700 text-white border-purple-700'
                              : 'bg-white text-slate-700 border-slate-300'
                          }`}
                        >
                          Producción
                        </button>
                        <button
                          type="button"
                          onClick={() => onChangeWorkspaceMode('sandbox')}
                          className={`px-2 py-1 rounded border font-medium ${
                            workspaceMode === 'sandbox'
                              ? 'bg-emerald-700 text-white border-emerald-700'
                              : 'bg-white text-slate-700 border-slate-300'
                          }`}
                        >
                          Sandbox
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
                      <input
                        type="text"
                        value={entry.independentData.independentBusinessName}
                        onChange={(e) =>
                          onUpdateEntry(entry.placeId, {
                            independentData: { independentBusinessName: e.target.value },
                          })
                        }
                        placeholder="Nombre comercial propio"
                        className="px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                      />
                      <input
                        type="text"
                        value={entry.independentData.independentPhone}
                        onChange={(e) =>
                          onUpdateEntry(entry.placeId, {
                            independentData: { independentPhone: e.target.value },
                          })
                        }
                        placeholder="Teléfono corroborado (+51...)"
                        className="px-2.5 py-1.5 border border-slate-300 rounded bg-white font-mono-tabular"
                      />
                      <input
                        type="text"
                        value={entry.independentData.independentAddress}
                        onChange={(e) =>
                          onUpdateEntry(entry.placeId, {
                            independentData: { independentAddress: e.target.value },
                          })
                        }
                        placeholder="Dirección propia / sede"
                        className="px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                      />
                      <input
                        type="text"
                        value={entry.independentData.district}
                        onChange={(e) =>
                          onUpdateEntry(entry.placeId, {
                            independentData: { district: e.target.value },
                          })
                        }
                        placeholder="Distrito"
                        className="px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                      />
                      <input
                        type="url"
                        value={entry.independentData.independentWebsite}
                        onChange={(e) =>
                          onUpdateEntry(entry.placeId, {
                            independentData: { independentWebsite: e.target.value },
                          })
                        }
                        placeholder="Web oficial propia (https://...)"
                        className="px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                      />
                      <input
                        type="email"
                        value={entry.independentData.independentEmail}
                        onChange={(e) =>
                          onUpdateEntry(entry.placeId, {
                            independentData: { independentEmail: e.target.value },
                          })
                        }
                        placeholder="Correo corporativo"
                        className="px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                      />
                      <input
                        type="text"
                        value={entry.independentData.independentDataProvenance || ''}
                        onChange={(e) =>
                          onUpdateEntry(entry.placeId, {
                            independentData: { independentDataProvenance: e.target.value },
                          })
                        }
                        placeholder="Procedencia (ej. web oficial / llamada directa)"
                        className="px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                      />
                      <input
                        type="text"
                        value={entry.independentData.legalBasis}
                        onChange={(e) =>
                          onUpdateEntry(entry.placeId, {
                            independentData: { legalBasis: e.target.value },
                          })
                        }
                        placeholder="Base legal / consentimiento (mín. 8 car.)"
                        className="px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                      />
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px]">
                      <div className="space-y-1">
                        <label className="flex items-center gap-1.5 cursor-pointer text-slate-700">
                          <input
                            type="checkbox"
                            checked={entry.independentData.confirmedNoWebsite}
                            onChange={(e) =>
                              onUpdateEntry(entry.placeId, {
                                independentData: { confirmedNoWebsite: e.target.checked },
                              })
                            }
                          />
                          Confirmado manualmente que no tiene web propia
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer text-emerald-950 font-medium">
                          <input
                            type="checkbox"
                            checked={entry.independentData.provenanceConfirmed}
                            onChange={(e) =>
                              onUpdateEntry(entry.placeId, {
                                independentData: {
                                  provenanceConfirmed: e.target.checked,
                                  independentDataProvenance:
                                    entry.independentData.independentDataProvenance?.trim() ||
                                    (e.target.checked ? 'user_manual_entry' : ''),
                                },
                              })
                            }
                          />
                          Confirmo procedencia independiente de estos campos (habilita recuperación {ttlHours}h y traslado al CRM)
                        </label>
                      </div>

                      <button
                        type="button"
                        disabled={!isSignedIn || promotingPlaceId === entry.placeId}
                        onClick={() => handlePromoteEntry(entry)}
                        className="px-3.5 py-2 text-xs font-semibold bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 disabled:opacity-40 inline-flex items-center gap-1.5 shrink-0"
                      >
                        <ArrowUpRight className="w-3.5 h-3.5" />
                        {!isSignedIn
                          ? 'Inicia sesión para guardar en CRM'
                          : promotingPlaceId === entry.placeId
                          ? 'Guardando en Firestore...'
                          : `Guardar en CRM (${workspaceMode === 'sandbox' ? 'Sandbox' : 'Producción'})`}
                      </button>
                    </div>

                    {feedbackForRow && (
                      <div
                        className={`text-xs px-3 py-2 rounded-lg border ${
                          feedbackForRow.ok
                            ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                            : 'bg-rose-50 border-rose-300 text-rose-900'
                        }`}
                      >
                        {feedbackForRow.message}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
