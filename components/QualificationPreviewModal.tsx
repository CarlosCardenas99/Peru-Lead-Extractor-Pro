import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Sparkles, X } from 'lucide-react';
import {
  BusinessLead,
  LeadQualificationResult,
  QualifierBatchSummary,
} from '../types';

interface QualificationPreviewModalProps {
  isOpen: boolean;
  isAnalyzing: boolean;
  progressLabel: string;
  geminiWarning: string | null;
  leads: BusinessLead[];
  results: LeadQualificationResult[];
  summary: QualifierBatchSummary | null;
  isSignedIn: boolean;
  isSaving: boolean;
  onClose: () => void;
  onConfirmTransfer: (selectedResults: LeadQualificationResult[]) => Promise<void>;
}

export const QualificationPreviewModal: React.FC<QualificationPreviewModalProps> = ({
  isOpen,
  isAnalyzing,
  progressLabel,
  geminiWarning,
  leads,
  results,
  summary,
  isSignedIn,
  isSaving,
  onClose,
  onConfirmTransfer,
}) => {
  const [viewMode, setViewMode] = useState<'eligible' | 'rejected'>('eligible');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const leadMap = useMemo(() => {
    const map = new Map<string, BusinessLead>();
    for (const l of leads) map.set(l.placeId, l);
    return map;
  }, [leads]);

  const eligibleResults = useMemo(
    () =>
      results.filter(
        (r) => r.tier === 'PRIORIDAD ALTA' || r.tier === 'REVISIÓN PENDIENTE'
      ),
    [results]
  );

  const rejectedResults = useMemo(
    () => results.filter((r) => r.tier === 'NO ELEGIBLE'),
    [results]
  );

  useEffect(() => {
    if (!isOpen) return;
    // Selecciona por defecto PRIORIDAD ALTA y REVISIÓN PENDIENTE para revisión explícita antes de transferir
    setSelectedIds(new Set(eligibleResults.map((r) => r.placeId)));
    setViewMode(eligibleResults.length > 0 ? 'eligible' : 'rejected');
  }, [isOpen, eligibleResults]);

  if (!isOpen) return null;

  const toggleId = (placeId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(placeId)) next.delete(placeId);
      else next.add(placeId);
      return next;
    });
  };

  const selectedList = eligibleResults.filter((r) => selectedIds.has(r.placeId));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Preselección automática de oportunidades WEBNEX"
    >
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold text-purple-700 inline-flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              WEBNEX Smart Lead Qualifier
            </div>
            <h2 className="text-lg font-semibold text-slate-900 mt-0.5">
              Análisis Completo y Preselección para Seguimiento
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              La preselección automática NO autoriza llamadas ni mensajería; solo guarda Place IDs y metadatos propios tras confirmar.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"
            aria-label="Cerrar resumen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-5">
          {isAnalyzing ? (
            <div className="py-12 text-center space-y-2">
              <div className="text-sm font-semibold text-purple-800">{progressLabel}</div>
              <p className="text-xs text-slate-500">
                Evaluando todos los resultados cargados (Place ID, teléfonos peruanos, exclusiones y señales web permitidas)...
              </p>
            </div>
          ) : (
            <>
              {summary && (
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5">
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-[11px] text-slate-500">Analizados</div>
                    <div className="text-xl font-semibold text-slate-900 font-mono-tabular">
                      {summary.totalEvaluated}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-emerald-50/70 border border-emerald-200">
                    <div className="text-[11px] text-emerald-800">Prioridad Alta</div>
                    <div className="text-xl font-semibold text-emerald-900 font-mono-tabular">
                      {summary.highPriorityCount}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-amber-50/70 border border-amber-200">
                    <div className="text-[11px] text-amber-800">Revisión Pendiente</div>
                    <div className="text-xl font-semibold text-amber-900 font-mono-tabular">
                      {summary.pendingReviewCount}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-[11px] text-slate-500">No Elegibles</div>
                    <div className="text-xl font-semibold text-slate-700 font-mono-tabular">
                      {summary.notEligibleCount}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-[11px] text-slate-500">Solo Fijo</div>
                    <div className="text-xl font-semibold text-slate-700 font-mono-tabular">
                      {summary.discardedLandlineCount}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-[11px] text-slate-500">Sin Móvil</div>
                    <div className="text-xl font-semibold text-slate-700 font-mono-tabular">
                      {summary.noMobileCount}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-[11px] text-slate-500">Excl./Ya CRM</div>
                    <div className="text-xl font-semibold text-slate-700 font-mono-tabular">
                      {summary.duplicatesAndExcludedCount + summary.alreadyInCrmSkippedCount}
                    </div>
                  </div>
                </div>
              )}

              {geminiWarning && (
                <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  {geminiWarning}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setViewMode('eligible')}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg border ${
                      viewMode === 'eligible'
                        ? 'bg-purple-700 text-white border-purple-700'
                        : 'bg-white text-slate-700 border-slate-300'
                    }`}
                  >
                    Preseleccionables ({eligibleResults.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('rejected')}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg border ${
                      viewMode === 'rejected'
                        ? 'bg-slate-800 text-white border-slate-800'
                        : 'bg-white text-slate-700 border-slate-300'
                    }`}
                  >
                    No Elegibles / Descartados ({rejectedResults.length})
                  </button>
                </div>

                {viewMode === 'eligible' && eligibleResults.length > 0 && (
                  <div className="flex gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedIds(new Set(eligibleResults.map((r) => r.placeId)))
                      }
                      className="text-purple-700 hover:underline font-medium"
                    >
                      Marcar todos
                    </button>
                    <span className="text-slate-300">|</span>
                    <button
                      type="button"
                      onClick={() => setSelectedIds(new Set())}
                      className="text-slate-600 hover:underline"
                    >
                      Desmarcar todos
                    </button>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                {(viewMode === 'eligible' ? eligibleResults : rejectedResults).length === 0 ? (
                  <div className="text-center py-8 text-xs text-slate-500 border border-slate-200 rounded-xl">
                    No hay establecimientos en esta categoría para el lote analizado.
                  </div>
                ) : (
                  (viewMode === 'eligible' ? eligibleResults : rejectedResults).map((res) => {
                    const lead = leadMap.get(res.placeId);
                    if (!lead) return null;
                    const checked = selectedIds.has(res.placeId);

                    return (
                      <div
                        key={res.placeId}
                        className={`border rounded-xl p-4 transition-colors ${
                          res.tier === 'PRIORIDAD ALTA'
                            ? 'border-emerald-200 bg-emerald-50/30'
                            : res.tier === 'REVISIÓN PENDIENTE'
                            ? 'border-amber-200 bg-amber-50/20'
                            : 'border-slate-200 bg-slate-50/50'
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            {viewMode === 'eligible' && (
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleId(res.placeId)}
                                className="mt-1 rounded border-slate-300 text-purple-700 focus:ring-purple-600"
                              />
                            )}
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold text-slate-900">
                                  {lead.name}
                                </span>
                                <span
                                  className={`text-[11px] font-semibold ${
                                    res.tier === 'PRIORIDAD ALTA'
                                      ? 'text-emerald-800'
                                      : res.tier === 'REVISIÓN PENDIENTE'
                                      ? 'text-amber-800'
                                      : 'text-slate-600'
                                  }`}
                                >
                                  · {res.tier}
                                </span>
                              </div>
                              <div className="text-xs text-slate-500 mt-0.5">
                                {lead.address} ·{' '}
                                <span className="font-mono-tabular">{lead.phone}</span>
                              </div>
                              <div className="text-[11px] text-slate-400 font-mono-tabular mt-0.5">
                                Place ID: {lead.placeId}
                              </div>
                            </div>
                          </div>

                          <div className="flex gap-4 text-right font-mono-tabular shrink-0">
                            <div>
                              <div className="text-[11px] text-slate-500">Oport. Digital</div>
                              <div className="text-sm font-semibold text-purple-800">
                                {res.digitalScore}/100
                              </div>
                            </div>
                            <div>
                              <div className="text-[11px] text-slate-500">Contactabilidad</div>
                              <div className="text-sm font-semibold text-slate-800">
                                {res.contactabilityScore}/100
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 space-y-1 text-xs text-slate-700">
                          {res.reasons.map((reason, idx) => (
                            <div key={idx}>• {reason}</div>
                          ))}
                        </div>

                        {res.missingInformation.length > 0 && (
                          <div className="mt-2 text-[11px] text-amber-800">
                            Por verificar: {res.missingInformation.join(' | ')}
                          </div>
                        )}

                        {res.geminiAnalysis && (
                          <div className="mt-3 bg-white border border-purple-200 rounded-lg p-3 text-xs space-y-1.5">
                            <div className="font-semibold text-purple-900">
                              Análisis técnico complementario (Gemini · sin contenido Maps)
                            </div>
                            {res.geminiAnalysis.digitalNeeds.length > 0 && (
                              <div className="text-slate-700">
                                <strong>Necesidades detectadas:</strong>{' '}
                                {res.geminiAnalysis.digitalNeeds.join('; ')}
                              </div>
                            )}
                            {res.geminiAnalysis.recommendedWebnexServices.length > 0 && (
                              <div className="text-slate-700">
                                <strong>Servicios WEBNEX sugeridos:</strong>{' '}
                                {res.geminiAnalysis.recommendedWebnexServices.join(', ')}
                              </div>
                            )}
                            {res.geminiAnalysis.manualVerificationSteps.length > 0 && (
                              <div className="text-slate-500 text-[11px]">
                                Verificación sugerida:{' '}
                                {res.geminiAnalysis.manualVerificationSteps.join(' · ')}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs text-slate-600">
            {isSignedIn
              ? `Seleccionados para transferir a Seguimiento: ${selectedList.length} (solo Place ID + metadatos propios).`
              : 'Inicia sesión con Google para confirmar y guardar preseleccionados en Firebase.'}
          </div>
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-700 hover:bg-slate-100"
            >
              Cerrar
            </button>
            <button
              type="button"
              disabled={!isSignedIn || isAnalyzing || isSaving || selectedList.length === 0}
              onClick={() => onConfirmTransfer(selectedList)}
              className="px-4 py-2 text-xs font-semibold bg-purple-700 hover:bg-purple-800 disabled:opacity-40 text-white rounded-lg inline-flex items-center gap-1.5"
            >
              <CheckCircle2 className="w-4 h-4" />
              {isSaving
                ? 'Guardando en CRM...'
                : `Confirmar y enviar (${selectedList.length}) a Seguimiento`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
