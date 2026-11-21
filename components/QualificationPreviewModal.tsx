import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Globe,
  Info,
  ListPlus,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import {
  BusinessLead,
  CrmWorkspaceMode,
  FieldResearchClassification,
  IndependentCorroborationResult,
  IndependentFieldSource,
  LeadQualificationResult,
  MissingDataResearchResult,
  PhoneLineType,
  QualifierBatchSummary,
  ResearchableFieldKey,
} from '../types';
import { researchMissingLeadDataBatch } from '../services/geminiService';
import { analyzePeruvianPhone } from '../utils/peruPhone';
import {
  encodeVerificationProvenanceEntry,
  evaluateFollowupCompleteness,
  FIELD_STORAGE_COMPLIANCE_MATRIX,
  formatIndependentSourceLabel,
  getFieldClassificationMeta,
  mergeVerificationSources,
  parseVerificationProvenanceEntry,
  resolveIndependentPhoneType,
  resolveIndependentWebsiteStatusForSave,
} from '../utils/fieldCompliance';

export interface PreparedTransferDraft {
  placeId: string;
  independentBusinessName: string;
  district: string;
  independentPhone: string;
  independentPhoneType: PhoneLineType;
  independentAddress: string;
  independentWebsite: string;
  independentEmail: string;
  independentCategory: string;
  confirmedNoWebsite: boolean;
  hasResearchContradictions?: boolean;
  verificationSummary: string;
  lastVerifiedAt: string;
  verificationSources: string[];
  notes: string;
}

export interface PreparedTransferItem {
  result: LeadQualificationResult;
  draft: PreparedTransferDraft;
}

interface QualificationPreviewModalProps {
  isOpen: boolean;
  isAnalyzing: boolean;
  progressLabel: string;
  geminiWarning: string | null;
  leads: BusinessLead[];
  results: LeadQualificationResult[];
  summary: QualifierBatchSummary | null;
  searchCategory?: string;
  searchDistrict?: string;
  isSignedIn: boolean;
  isSaving: boolean;
  workspaceMode?: CrmWorkspaceMode;
  onChangeWorkspaceMode?: (mode: CrmWorkspaceMode) => void;
  onAddSelectedToTemporaryQueue?: (placeIds: string[]) => void;
  onClose: () => void;
  onConfirmTransfer: (selectedItems: PreparedTransferItem[]) => Promise<void>;
}

function buildInitialDraft(
  lead: BusinessLead,
  result: LeadQualificationResult,
  searchCategory: string,
  searchDistrict: string
): PreparedTransferDraft {
  const nowIso = new Date().toISOString();
  const sources: string[] = [];
  const cleanDistrict = searchDistrict.replace(/,?\s*per[uú]$/i, '').trim();
  const cleanCategory = (searchCategory || lead.category || '').trim();

  if (cleanCategory) {
    sources.push(
      encodeVerificationProvenanceEntry({
        field: 'categoría',
        source: 'user_search_context',
        evidence: cleanCategory,
        verifiedAt: nowIso,
      })
    );
  }
  if (cleanDistrict) {
    sources.push(
      encodeVerificationProvenanceEntry({
        field: 'distrito',
        source: 'user_search_context',
        evidence: cleanDistrict,
        verifiedAt: nowIso,
      })
    );
  }
  if (lead.independentPhone.trim()) {
    sources.push(
      encodeVerificationProvenanceEntry({
        field: 'teléfono',
        source: 'user_manual_entry',
        evidence: lead.independentPhone.trim(),
        verifiedAt: nowIso,
      })
    );
  }
  if (lead.independentEmail.trim()) {
    sources.push(
      encodeVerificationProvenanceEntry({
        field: 'correo',
        source: 'user_manual_entry',
        evidence: lead.independentEmail.trim(),
        verifiedAt: nowIso,
      })
    );
  }
  if (lead.confirmedNoWebsite) {
    sources.push(
      encodeVerificationProvenanceEntry({
        field: 'sin_web',
        source: 'user_manual_entry',
        evidence: 'Confirmado manualmente sin web',
        verifiedAt: nowIso,
      })
    );
  } else if (lead.websiteProbe.provenance === 'independent_http' && lead.websiteProbe.checkedUrl) {
    sources.push(
      encodeVerificationProvenanceEntry({
        field: 'sonda_web',
        source: 'ssrf_http_probe',
        evidence: `${lead.websiteProbe.status} (${lead.websiteProbe.checkedUrl})`,
        verifiedAt: lead.websiteProbe.verifiedAt || nowIso,
      })
    );
  }

  return {
    placeId: lead.placeId,
    // Cumplimiento ToS: NUNCA copiar displayName/formattedAddress/phone/website de Google Places como independientes
    independentBusinessName: '',
    district: cleanDistrict,
    independentPhone: lead.independentPhone.trim(),
    independentPhoneType: resolveIndependentPhoneType(lead.independentPhone),
    independentAddress: '',
    independentWebsite: '',
    independentEmail: lead.independentEmail.trim(),
    independentCategory: cleanCategory,
    confirmedNoWebsite: lead.confirmedNoWebsite,
    verificationSummary:
      lead.confirmedNoWebsite
        ? 'Confirmado sin sitio web propio; listo para captura o verificación independiente.'
        : lead.website
        ? 'Pendiente de corroborar datos desde sitio web oficial o captura legítima.'
        : 'Sin web oficial; distrito y categoría tomados del contexto propio de búsqueda.',
    lastVerifiedAt: nowIso,
    verificationSources: sources,
    notes: [lead.independentWebsiteNote.trim(), result.reasons.join(' ')]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 950),
  };
}

function applyCorroborationToDraft(
  prev: PreparedTransferDraft,
  corr: IndependentCorroborationResult
): PreparedTransferDraft {
  const incomingSources: string[] = [];
  const next: PreparedTransferDraft = { ...prev };

  const applyCandidate = (
    fieldLabel: string,
    currentVal: string,
    candidate: { value: string; source: any; evidenceUrl: string | null; verifiedAt: string } | null
  ): string => {
    if (!candidate || !candidate.value) return currentVal;
    if (currentVal.trim()) return currentVal; // Nunca sobrescribir edición previa del usuario
    incomingSources.push(
      encodeVerificationProvenanceEntry({
        field: fieldLabel,
        source: candidate.source,
        evidence: candidate.evidenceUrl || candidate.value,
        verifiedAt: candidate.verifiedAt,
      })
    );
    return candidate.value;
  };

  next.independentBusinessName = applyCandidate(
    'nombre',
    prev.independentBusinessName,
    corr.candidates.businessName
  );
  next.independentPhone = applyCandidate('teléfono', prev.independentPhone, corr.candidates.phone);
  if (corr.candidates.phoneType && next.independentPhone.trim()) {
    next.independentPhoneType = resolveIndependentPhoneType(
      next.independentPhone,
      corr.candidates.phoneType.value
    );
  }
  next.independentAddress = applyCandidate(
    'dirección',
    prev.independentAddress,
    corr.candidates.address
  );
  next.district = applyCandidate('distrito', prev.district, corr.candidates.district);
  next.independentWebsite = applyCandidate('web', prev.independentWebsite, corr.candidates.website);
  next.independentEmail = applyCandidate('correo', prev.independentEmail, corr.candidates.email);
  next.independentCategory = applyCandidate(
    'categoría',
    prev.independentCategory,
    corr.candidates.category
  );

  next.verificationSummary = corr.summary;
  next.lastVerifiedAt = new Date().toISOString();
  next.verificationSources = mergeVerificationSources(prev.verificationSources, incomingSources, 8);
  return next;
}

function applyResearchResultToDraft(
  prev: PreparedTransferDraft,
  research: MissingDataResearchResult
): PreparedTransferDraft {
  const updated = applyCorroborationToDraft(prev, research.corroboration);
  return {
    ...updated,
    hasResearchContradictions: research.hasContradictions,
  };
}

export const QualificationPreviewModal: React.FC<QualificationPreviewModalProps> = ({
  isOpen,
  isAnalyzing,
  progressLabel,
  geminiWarning,
  leads,
  results,
  summary,
  searchCategory = '',
  searchDistrict = '',
  isSignedIn,
  isSaving,
  workspaceMode = 'production',
  onChangeWorkspaceMode,
  onAddSelectedToTemporaryQueue,
  onClose,
  onConfirmTransfer,
}) => {
  const wasOpenRef = useRef(false);
  const [viewMode, setViewMode] = useState<'eligible' | 'rejected'>('eligible');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [draftsByPlaceId, setDraftsByPlaceId] = useState<Record<string, PreparedTransferDraft>>({});
  const [researchByPlaceId, setResearchByPlaceId] = useState<Record<string, MissingDataResearchResult>>({});
  const [socialUrlsByPlaceId, setSocialUrlsByPlaceId] = useState<Record<string, string>>({});
  const [evidenceTextByPlaceId, setEvidenceTextByPlaceId] = useState<Record<string, string>>({});
  const [researchingPlaceId, setResearchingPlaceId] = useState<string | null>(null);
  const [manualCaptureSource, setManualCaptureSource] =
    useState<IndependentFieldSource>('user_manual_entry');
  const [provenanceConfirmed, setProvenanceConfirmed] = useState(false);
  const [isCorroborating, setIsCorroborating] = useState(false);
  const [corroborationNotice, setCorroborationNotice] = useState<string | null>(null);
  const [showComplianceMatrix, setShowComplianceMatrix] = useState(false);

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
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }

    const isFreshOpen = !wasOpenRef.current;
    wasOpenRef.current = true;

    if (isFreshOpen) {
      setSelectedIds(new Set(eligibleResults.map((r) => r.placeId)));
      setViewMode(eligibleResults.length > 0 ? 'eligible' : 'rejected');
      setCorroborationNotice(null);
      setResearchByPlaceId({});
      setSocialUrlsByPlaceId({});
      setEvidenceTextByPlaceId({});
      setResearchingPlaceId(null);
      setManualCaptureSource('user_manual_entry');
      setProvenanceConfirmed(false);
    } else if (eligibleResults.length > 0) {
      // Si el análisis terminó mientras ya estaba abierto, inicializar selección si aún estaba vacía
      setSelectedIds((prev) =>
        prev.size === 0 ? new Set(eligibleResults.map((r) => r.placeId)) : prev
      );
      setViewMode((prev) => (prev === 'rejected' && eligibleResults.length > 0 ? 'eligible' : prev));
    }

    setDraftsByPlaceId((prev) => {
      const next: Record<string, PreparedTransferDraft> = isFreshOpen ? {} : { ...prev };
      for (const res of eligibleResults) {
        if (!isFreshOpen && next[res.placeId]) {
          // Conservar SIEMPRE el borrador editado o corroborado por el usuario mientras el modal siga abierto
          continue;
        }
        const lead = leadMap.get(res.placeId);
        if (lead) {
          next[res.placeId] = buildInitialDraft(lead, res, searchCategory, searchDistrict);
        }
      }
      return next;
    });
  }, [isOpen, eligibleResults, leadMap, searchCategory, searchDistrict]);

  if (!isOpen) return null;

  const toggleId = (placeId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(placeId)) next.delete(placeId);
      else next.add(placeId);
      return next;
    });
  };

  const updateDraftField = (
    placeId: string,
    field: keyof PreparedTransferDraft,
    value: string | boolean,
    provenanceFieldLabel?: string
  ) => {
    setDraftsByPlaceId((prev) => {
      const current = prev[placeId];
      if (!current) return prev;
      const nowIso = new Date().toISOString();
      const updated: PreparedTransferDraft = {
        ...current,
        [field]: value,
        lastVerifiedAt: nowIso,
      };
      if (field === 'independentPhone' && typeof value === 'string') {
        const parsed = analyzePeruvianPhone(value);
        updated.independentPhoneType = parsed.lineType;
      }
      if (provenanceFieldLabel) {
        const evidenceStr = typeof value === 'boolean' ? (value ? 'Confirmado sin web' : 'No') : String(value).trim();
        if (evidenceStr) {
          const entry = encodeVerificationProvenanceEntry({
            field: provenanceFieldLabel,
            source: manualCaptureSource,
            evidence: evidenceStr,
            verifiedAt: nowIso,
          });
          updated.verificationSources = mergeVerificationSources(
            [entry],
            current.verificationSources,
            8
          );
        }
      }
      return { ...prev, [placeId]: updated };
    });
  };

  const handleResearchMissingData = async (singlePlaceId?: string) => {
    const targetIds = singlePlaceId
      ? [singlePlaceId]
      : eligibleResults.filter((r) => selectedIds.has(r.placeId)).map((r) => r.placeId);
    if (targetIds.length === 0) return;

    const payloadItems = targetIds
      .map((placeId) => {
        const lead = leadMap.get(placeId);
        const draft = draftsByPlaceId[placeId];
        if (!lead) return null;
        const userEvidence = (evidenceTextByPlaceId[placeId] || '').trim();
        return {
          placeId,
          officialWebsiteUrl: draft?.independentWebsite || lead.website || null,
          socialOrDirectoryUrl: (socialUrlsByPlaceId[placeId] || '').trim() || null,
          userProvidedEvidenceText: userEvidence,
          notesText: draft?.notes || lead.independentWebsiteNote || '',
          searchCategory: draft?.independentCategory || searchCategory || lead.category,
          searchDistrict: draft?.district || searchDistrict,
          allowGeminiEvidenceAnalysis: userEvidence.length >= 15,
          sessionMapsRef: {
            name: lead.name,
            address: lead.address,
            phone: lead.phone !== 'Sin teléfono' ? lead.phone : '',
            website: lead.website || '',
            district: searchDistrict.replace(/,?\s*per[uú]$/i, '').trim(),
          },
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    if (singlePlaceId) setResearchingPlaceId(singlePlaceId);
    else setIsCorroborating(true);
    setCorroborationNotice(null);
    try {
      const response = await researchMissingLeadDataBatch(payloadItems);
      const resultsList = response.results || [];
      let enrichedCount = 0;
      let completeReadyCount = 0;
      let contradictionsCount = 0;

      setResearchByPlaceId((prev) => {
        const next = { ...prev };
        for (const r of resultsList) next[r.placeId] = r;
        return next;
      });

      setDraftsByPlaceId((prev) => {
        const next = { ...prev };
        for (const research of resultsList) {
          if (research.canPersistCompleteCard) completeReadyCount += 1;
          if (research.hasContradictions) contradictionsCount += 1;
          const existing = next[research.placeId];
          if (!existing) continue;
          const updated = applyResearchResultToDraft(existing, research);
          if (
            updated.independentBusinessName !== existing.independentBusinessName ||
            updated.independentPhone !== existing.independentPhone ||
            updated.independentAddress !== existing.independentAddress ||
            updated.independentWebsite !== existing.independentWebsite ||
            updated.independentEmail !== existing.independentEmail
          ) {
            enrichedCount += 1;
          }
          next[research.placeId] = updated;
        }
        return next;
      });
      setCorroborationNotice(
        `Investigación independiente completada sobre ${resultsList.length} prospecto(s) (0 consultas a Google Places). ${enrichedCount} ficha(s) recibieron nuevos campos persistibles · ${completeReadyCount} listas completas · ${contradictionsCount} con alertas/contradicciones.`
      );
    } finally {
      if (singlePlaceId) setResearchingPlaceId(null);
      else setIsCorroborating(false);
    }
  };

  const selectedItems: PreparedTransferItem[] = eligibleResults
    .filter((r) => selectedIds.has(r.placeId))
    .map((result) => {
      const lead = leadMap.get(result.placeId)!;
      const draft =
        draftsByPlaceId[result.placeId] ||
        buildInitialDraft(lead, result, searchCategory, searchDistrict);
      return { result, draft };
    });

  const completeCount = selectedItems.filter(
    ({ draft }) =>
      evaluateFollowupCompleteness({
        ...draft,
        confirmedNoWebsite: draft.confirmedNoWebsite,
      }).status === 'complete'
  ).length;

  const hasManualCommercialFieldsInBatch = selectedItems.some(({ draft }) => {
    const manualSourcesInDraft = new Set(
      draft.verificationSources
        .map((s) => parseVerificationProvenanceEntry(s))
        .filter((p) => p.source === 'official_website_jsonld' || p.source === 'official_website_html')
        .map((p) => p.field)
    );
    return Boolean(
      (draft.independentBusinessName.trim() && !manualSourcesInDraft.has('nombre')) ||
        (draft.independentAddress.trim() && !manualSourcesInDraft.has('dirección')) ||
        (draft.independentWebsite.trim() && !manualSourcesInDraft.has('web'))
    );
  });

  const handleConfirmWithProvenance = async () => {
    if (hasManualCommercialFieldsInBatch && !provenanceConfirmed) {
      setCorroborationNotice(
        'Confirma explícitamente la casilla de procedencia independiente antes de enviar campos comerciales capturados manualmente.'
      );
      return;
    }

    const nowIso = new Date().toISOString();
    const enrichedItems: PreparedTransferItem[] = selectedItems.map(({ result, draft }) => {
      const incoming: string[] = [];
      const pushIfPresent = (field: string, val: string) => {
        if (!val.trim()) return;
        incoming.push(
          encodeVerificationProvenanceEntry({
            field,
            source: manualCaptureSource,
            evidence: val.trim(),
            verifiedAt: nowIso,
          })
        );
      };
      pushIfPresent('nombre', draft.independentBusinessName);
      pushIfPresent('teléfono', draft.independentPhone);
      pushIfPresent('dirección', draft.independentAddress);
      pushIfPresent('distrito', draft.district);
      pushIfPresent('web', draft.independentWebsite);
      pushIfPresent('correo', draft.independentEmail);
      pushIfPresent('categoría', draft.independentCategory);
      if (draft.confirmedNoWebsite) {
        pushIfPresent('sin_web', 'Confirmado sin web propia');
      }

      return {
        result,
        draft: {
          ...draft,
          lastVerifiedAt: draft.lastVerifiedAt || nowIso,
          verificationSources: mergeVerificationSources(draft.verificationSources, incoming, 8),
        },
      };
    });

    await onConfirmTransfer(enrichedItems);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Preparar ficha para Seguimiento y preselección"
    >
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold text-purple-700 inline-flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              Fase: Preparar Ficha para Seguimiento · WEBNEX Smart Lead Qualifier
            </div>
            <h2 className="text-lg font-semibold text-slate-900 mt-0.5">
              Corroboración Independiente y Transferencia Segura a Firestore
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Reutiliza la sesión actual de Explorador (0 llamadas adicionales a Google Places). Los campos comerciales persistentes solo se guardan cuando provienen de web oficial, contexto propio de búsqueda o captura legítima del usuario.
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

              {/* Toolbar de Investigación de Datos Faltantes (0 Places) & Matriz de Permisos */}
              {viewMode === 'eligible' && eligibleResults.length > 0 && (() => {
                const needingDataCount = selectedItems.filter(
                  ({ draft }) =>
                    evaluateFollowupCompleteness({
                      ...draft,
                      confirmedNoWebsite: draft.confirmedNoWebsite,
                    }).isFichaIncompleta
                ).length;

                return (
                  <div className="bg-purple-50/60 border border-purple-200 rounded-xl p-4 space-y-3">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                      <div className="text-xs text-purple-950">
                        <div className="font-semibold flex items-center gap-1.5">
                          <ShieldCheck className="w-4 h-4 text-purple-700 shrink-0" />
                          Investigar datos faltantes (0 Places) · Corroboración para Firestore
                        </div>
                        <p className="text-purple-900/80 mt-0.5">
                          <strong>{needingDataCount}</strong> de <strong>{selectedItems.length}</strong> candidato(s) preseleccionado(s) requieren datos comerciales independientes persistibles. Consulta web oficial, Meta oEmbed/estado de acceso, padrón empresarial abierto (DatosPeru/SUNAT) y evidencia provista sin copiar campos de Google Maps.
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => setShowComplianceMatrix((v) => !v)}
                          className="px-3 py-1.5 text-xs font-medium border border-purple-300 bg-white text-purple-800 rounded-lg hover:bg-purple-50 inline-flex items-center gap-1"
                        >
                          <Info className="w-3.5 h-3.5" />
                          {showComplianceMatrix ? 'Ocultar matriz ToS' : 'Ver matriz de permisos'}
                        </button>
                        <button
                          type="button"
                          disabled={isCorroborating || selectedItems.length === 0}
                          onClick={() => handleResearchMissingData()}
                          className="px-3.5 py-1.5 text-xs font-semibold bg-purple-700 text-white rounded-lg hover:bg-purple-800 disabled:opacity-50 inline-flex items-center gap-1.5"
                        >
                          <Search className="w-3.5 h-3.5" />
                          {isCorroborating
                            ? 'Investigando fuentes (0 Places)...'
                            : 'Investigar datos faltantes (0 Places)'}
                        </button>
                      </div>
                    </div>

                    <div className="text-[11px] text-slate-700 bg-white/80 border border-purple-100 rounded-lg px-3 py-2 space-y-1">
                      <div>
                        Embudo obligatorio: <strong>1. Candidato Maps</strong> → <strong>2. Ficha comercial corroborada</strong> → <strong>3. Contacto legalmente autorizado</strong> → <strong>4. Contacto alcanzado</strong>.
                      </div>
                      <div className="text-slate-600">
                        Separación estricta de conceptos: <strong>(1) Formato telefónico válido</strong> ≠ <strong>(2) Teléfono corroborado</strong> ≠ <strong>(3) Autorización de contacto</strong> ≠ <strong>(4) Resultado real</strong>. Un celular válido no demuestra WhatsApp ni permiso de llamada.
                      </div>
                    </div>

                    {corroborationNotice && (
                      <div className="text-xs bg-white border border-purple-200 text-purple-900 rounded-lg px-3 py-2">
                        {corroborationNotice}
                      </div>
                    )}

                  {showComplianceMatrix && (
                    <div className="bg-white border border-purple-200 rounded-lg overflow-x-auto">
                      <table className="w-full text-left text-[11px] border-collapse">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
                          <tr>
                            <th className="py-2 px-3">Campo</th>
                            <th className="py-2 px-3">Origen Google Maps</th>
                            <th className="py-2 px-3">Origen Independiente</th>
                            <th className="py-2 px-3">Criterio de persistencia</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {FIELD_STORAGE_COMPLIANCE_MATRIX.map((row) => (
                            <tr key={row.field}>
                              <td className="py-1.5 px-3 font-mono-tabular font-semibold text-slate-800">
                                {row.field}
                              </td>
                              <td className="py-1.5 px-3 text-slate-600">{row.placesOriginPolicy}</td>
                              <td className="py-1.5 px-3 text-emerald-800 font-medium">
                                {row.independentOriginPolicy}
                              </td>
                              <td className="py-1.5 px-3 text-slate-600">{row.explanation}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                );
              })()}

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

              <div className="space-y-4">
                {(viewMode === 'eligible' ? eligibleResults : rejectedResults).length === 0 ? (
                  <div className="text-center py-8 text-xs text-slate-500 border border-slate-200 rounded-xl">
                    No hay establecimientos en esta categoría para el lote analizado.
                  </div>
                ) : (
                  (viewMode === 'eligible' ? eligibleResults : rejectedResults).map((res) => {
                    const lead = leadMap.get(res.placeId);
                    if (!lead) return null;
                    const checked = selectedIds.has(res.placeId);
                    const draft =
                      draftsByPlaceId[res.placeId] ||
                      buildInitialDraft(lead, res, searchCategory, searchDistrict);

                    const completeness = evaluateFollowupCompleteness({
                      ...draft,
                      confirmedNoWebsite: draft.confirmedNoWebsite,
                    });

                    const completenessStyle =
                      completeness.status === 'complete'
                        ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
                        : completeness.status === 'partial'
                        ? 'bg-amber-100 text-amber-900 border-amber-300'
                        : 'bg-slate-100 text-slate-700 border-slate-300';

                    return (
                      <div
                        key={res.placeId}
                        className={`border rounded-xl p-4 transition-colors ${
                          res.tier === 'PRIORIDAD ALTA'
                            ? 'border-emerald-200 bg-emerald-50/20'
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
                                {viewMode === 'eligible' && (
                                  <span
                                    className={`px-2 py-0.5 text-[10px] font-semibold border rounded ${completenessStyle}`}
                                  >
                                    {completeness.label}
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-slate-500 mt-0.5">
                                Ref. sesión Explorador: {lead.address} ·{' '}
                                <span className="font-mono-tabular">{lead.phone}</span>
                                {lead.website ? ` · ${lead.website}` : ''}
                              </div>
                              <div className="text-[11px] text-slate-400 font-mono-tabular mt-0.5">
                                Place ID: {lead.placeId}
                              </div>
                            </div>
                          </div>

                          <div className="flex flex-wrap gap-3 text-right font-mono-tabular shrink-0">
                            <div>
                              <div className="text-[11px] text-slate-500">Neces. Digital</div>
                              <div className="text-sm font-semibold text-purple-800">
                                {res.digitalScore}/100
                              </div>
                            </div>
                            <div>
                              <div className="text-[11px] text-slate-500">Calidad Contacto</div>
                              <div className="text-sm font-semibold text-slate-800">
                                {res.contactabilityScore}/100
                              </div>
                            </div>
                            <div>
                              <div className="text-[11px] text-slate-500">Confianza Info</div>
                              <div
                                className={`text-sm font-semibold ${
                                  res.trustScore < 50 ? 'text-amber-700' : 'text-emerald-800'
                                }`}
                              >
                                {res.trustScore}/100
                              </div>
                            </div>
                            <div>
                              <div className="text-[11px] text-slate-500">Prioridad</div>
                              <div className="text-sm font-semibold text-slate-900">
                                {res.combinedPriorityScore}/100
                              </div>
                            </div>
                          </div>
                        </div>

                        {res.contradictions.length > 0 && (
                          <div className="mt-2 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-md px-2.5 py-1.5">
                            <strong>Alertas / Contradicciones:</strong> {res.contradictions.join(' ')}
                          </div>
                        )}

                        <div className="mt-2 space-y-0.5 text-xs text-slate-700">
                          {res.reasons.map((reason, idx) => (
                            <div key={idx}>• {reason}</div>
                          ))}
                        </div>

                        {viewMode === 'eligible' && checked && (
                          <div className="mt-3 bg-white border border-slate-200 rounded-lg p-3 space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-[11px] font-semibold text-slate-800">
                                Campos comerciales persistentes para Firebase (origen independiente verificado)
                              </span>
                              {completeness.missingFields.length > 0 && (
                                <span className="text-[11px] text-amber-800">
                                  FICHA INCOMPLETA — pasará a cola de investigación hasta corroborar: {completeness.missingFields.join(', ')}
                                </span>
                              )}
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-xs">
                              <div>
                                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">
                                  Nombre comercial propio / web oficial
                                </label>
                                <input
                                  type="text"
                                  value={draft.independentBusinessName}
                                  onChange={(e) =>
                                    updateDraftField(
                                      res.placeId,
                                      'independentBusinessName',
                                      e.target.value,
                                      'nombre'
                                    )
                                  }
                                  placeholder="Captura o web oficial"
                                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs"
                                />
                              </div>

                              <div>
                                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">
                                  Teléfono corroborado ({resolveIndependentPhoneType(draft.independentPhone)})
                                </label>
                                <input
                                  type="text"
                                  value={draft.independentPhone}
                                  onChange={(e) =>
                                    updateDraftField(
                                      res.placeId,
                                      'independentPhone',
                                      e.target.value,
                                      'teléfono'
                                    )
                                  }
                                  placeholder="+51 9XX XXX XXX"
                                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs font-mono-tabular"
                                />
                              </div>

                              <div>
                                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">
                                  Dirección corroborada / propia
                                </label>
                                <input
                                  type="text"
                                  value={draft.independentAddress}
                                  onChange={(e) =>
                                    updateDraftField(
                                      res.placeId,
                                      'independentAddress',
                                      e.target.value,
                                      'dirección'
                                    )
                                  }
                                  placeholder="Av. / Jr. / Calle (web oficial o propia)"
                                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs"
                                />
                              </div>

                              <div>
                                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">
                                  Distrito / Zona
                                </label>
                                <input
                                  type="text"
                                  value={draft.district}
                                  onChange={(e) =>
                                    updateDraftField(res.placeId, 'district', e.target.value, 'distrito')
                                  }
                                  placeholder="Ej: Los Olivos"
                                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs"
                                />
                              </div>

                              <div>
                                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">
                                  Sitio web oficial corroborado
                                </label>
                                <input
                                  type="url"
                                  value={draft.independentWebsite}
                                  onChange={(e) =>
                                    updateDraftField(
                                      res.placeId,
                                      'independentWebsite',
                                      e.target.value,
                                      'web'
                                    )
                                  }
                                  placeholder="https://empresa.pe"
                                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs"
                                />
                              </div>

                              <div>
                                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">
                                  Correo y Categoría propia
                                </label>
                                <div className="grid grid-cols-2 gap-1.5">
                                  <input
                                    type="email"
                                    value={draft.independentEmail}
                                    onChange={(e) =>
                                      updateDraftField(
                                        res.placeId,
                                        'independentEmail',
                                        e.target.value,
                                        'correo'
                                      )
                                    }
                                    placeholder="Correo"
                                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-xs"
                                  />
                                  <input
                                    type="text"
                                    value={draft.independentCategory}
                                    onChange={(e) =>
                                      updateDraftField(
                                        res.placeId,
                                        'independentCategory',
                                        e.target.value,
                                        'categoría'
                                      )
                                    }
                                    placeholder="Categoría"
                                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-xs"
                                  />
                                </div>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
                              <div className="flex flex-wrap items-center gap-3">
                                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={draft.confirmedNoWebsite}
                                    onChange={(e) =>
                                      updateDraftField(
                                        res.placeId,
                                        'confirmedNoWebsite',
                                        e.target.checked,
                                        'sin_web'
                                      )
                                    }
                                  />
                                  Confirmado manualmente sin sitio web propio
                                </label>
                                {draft.independentWebsite.trim() && (
                                  <span className="font-mono-tabular text-[10px] px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-700">
                                    Estado Web a guardar:{' '}
                                    {resolveIndependentWebsiteStatusForSave({
                                      independentWebsite: draft.independentWebsite,
                                      confirmedNoWebsite: draft.confirmedNoWebsite,
                                      verifiedProbe: lead.websiteProbe,
                                    })}
                                  </span>
                                )}
                              </div>
                              {draft.verificationSources.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                  {draft.verificationSources.slice(0, 4).map((raw, i) => {
                                    const parsed = parseVerificationProvenanceEntry(raw);
                                    return (
                                      <span
                                        key={i}
                                        className="px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-700"
                                        title={parsed.evidence}
                                      >
                                        {parsed.field}: {formatIndependentSourceLabel(parsed.source)}
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                            </div>

                            {/* Entradas de investigación independiente por candidato + Clasificación de 4 estados */}
                            <div className="pt-2.5 border-t border-slate-200 space-y-2.5">
                              <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
                                <div className="md:col-span-5">
                                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">
                                    URL de Facebook / Instagram / DatosPeru (opcional)
                                  </label>
                                  <input
                                    type="url"
                                    value={socialUrlsByPlaceId[res.placeId] || ''}
                                    onChange={(e) =>
                                      setSocialUrlsByPlaceId((prev) => ({
                                        ...prev,
                                        [res.placeId]: e.target.value,
                                      }))
                                    }
                                    placeholder="https://facebook.com/... o datosperu.org/empresa-..."
                                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs"
                                  />
                                </div>
                                <div className="md:col-span-5">
                                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">
                                    Evidencia comercial provista por usuario (bio / tarjeta / nota)
                                  </label>
                                  <input
                                    type="text"
                                    value={evidenceTextByPlaceId[res.placeId] || ''}
                                    onChange={(e) =>
                                      setEvidenceTextByPlaceId((prev) => ({
                                        ...prev,
                                        [res.placeId]: e.target.value,
                                      }))
                                    }
                                    placeholder="Pega datos visibles propios para extracción literal (0 invención)"
                                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs"
                                  />
                                </div>
                                <div className="md:col-span-2">
                                  <button
                                    type="button"
                                    disabled={
                                      researchingPlaceId === res.placeId || isCorroborating
                                    }
                                    onClick={() => handleResearchMissingData(res.placeId)}
                                    className="w-full px-2.5 py-1.5 text-xs font-semibold border border-purple-300 bg-purple-50 text-purple-900 rounded-md hover:bg-purple-100 disabled:opacity-50 inline-flex items-center justify-center gap-1"
                                  >
                                    <Globe className="w-3.5 h-3.5" />
                                    {researchingPlaceId === res.placeId
                                      ? 'Buscando...'
                                      : 'Investigar (0 Places)'}
                                  </button>
                                </div>
                              </div>

                              {researchByPlaceId[res.placeId] && (() => {
                                const research = researchByPlaceId[res.placeId];
                                const fieldKeys: ResearchableFieldKey[] = [
                                  'businessName',
                                  'phone',
                                  'address',
                                  'district',
                                  'website',
                                  'email',
                                  'category',
                                ];
                                return (
                                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2.5 text-[11px]">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <span className="font-semibold text-slate-800">
                                        Resultado investigación (0 Places): {research.identityMatch.summary}
                                      </span>
                                      <span
                                        className={`px-2 py-0.5 border rounded font-semibold ${
                                          research.hasContradictions
                                            ? 'bg-rose-50 text-rose-900 border-rose-300'
                                            : research.canPersistCompleteCard
                                            ? 'bg-emerald-50 text-emerald-900 border-emerald-300'
                                            : 'bg-amber-50 text-amber-900 border-amber-300'
                                        }`}
                                      >
                                        {research.hasContradictions
                                          ? 'Contradicción -> PENDIENTE DE VERIFICACIÓN'
                                          : research.canPersistCompleteCard
                                          ? 'Completa persistible'
                                          : research.identityMatch.identityStatusLabel === 'IDENTIDAD NO CONFIRMADA'
                                          ? 'IDENTIDAD NO CONFIRMADA -> PENDIENTE DE VERIFICACIÓN'
                                          : 'Cola investigación -> PENDIENTE DE VERIFICACIÓN'}
                                      </span>
                                    </div>

                                    {research.contradictionAlerts.length > 0 && (
                                      <div className="bg-rose-50 border border-rose-300 text-rose-900 rounded px-2.5 py-2 space-y-0.5">
                                        <div className="font-semibold flex items-center gap-1">
                                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                          Contradicción detectada (no auto-completado)
                                        </div>
                                        {research.contradictionAlerts.map((alert, i) => (
                                          <div key={i}>• {alert}</div>
                                        ))}
                                      </div>
                                    )}

                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-1.5">
                                      {fieldKeys.map((fk) => {
                                        const fc: FieldResearchClassification =
                                          research.fieldClassifications[fk];
                                        const meta = getFieldClassificationMeta(fc.status);
                                        return (
                                          <div
                                            key={fk}
                                            className="bg-white border border-slate-200 rounded p-2 space-y-0.5"
                                            title={fc.reason}
                                          >
                                            <div className="flex items-center justify-between gap-1">
                                              <span className="font-semibold text-slate-700">
                                                {fc.label}
                                              </span>
                                              <span
                                                className={`px-1.5 py-0.5 text-[10px] border rounded ${meta.badgeClass}`}
                                              >
                                                {meta.shortLabel}
                                              </span>
                                            </div>
                                            <div className="text-slate-900 truncate">
                                              {fc.independentValue ||
                                                fc.mapsSessionValue ||
                                                'Sin registro'}
                                            </div>
                                            <div className="text-[10px] text-slate-500 truncate">
                                              {fc.sourceLabel}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>

                                    <div className="space-y-1">
                                      <div className="font-semibold text-slate-700">
                                        Fuentes consultadas honestamente:
                                      </div>
                                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                        {research.sourceAttempts.map((att, idx) => (
                                          <div
                                            key={idx}
                                            className="bg-white border border-slate-200 rounded px-2 py-1.5"
                                          >
                                            <div className="font-medium text-slate-800">
                                              {att.sourceName} ·{' '}
                                              <span className="font-mono-tabular">
                                                {att.status}
                                                {att.httpStatus ? ` (HTTP ${att.httpStatus})` : ''}
                                              </span>
                                            </div>
                                            <div className="text-[10px] text-slate-600">
                                              {att.detail} ({att.costNote})
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>

                                    {research.manualReviewLinks.length > 0 &&
                                      research.recommendedQueue === 'research_queue' && (
                                        <div className="flex flex-wrap items-center gap-2 pt-1">
                                          <span className="font-semibold text-slate-700">
                                            Revisión manual sin scraping:
                                          </span>
                                          {research.manualReviewLinks.map((lnk, i) => (
                                            <a
                                              key={i}
                                              href={lnk.url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="inline-flex items-center gap-1 text-purple-700 hover:underline font-medium"
                                              title={lnk.note}
                                            >
                                              {lnk.label}
                                              <ExternalLink className="w-3 h-3" />
                                            </a>
                                          ))}
                                        </div>
                                      )}
                                  </div>
                                );
                              })()}
                            </div>
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
                            {res.geminiAnalysis.observedEvidence && res.geminiAnalysis.observedEvidence.length > 0 && (
                              <div className="text-slate-700">
                                <strong>Evidencia HTML observada:</strong>{' '}
                                {res.geminiAnalysis.observedEvidence.join('; ')}
                              </div>
                            )}
                            {res.geminiAnalysis.contradictions && res.geminiAnalysis.contradictions.length > 0 && (
                              <div className="text-rose-700">
                                <strong>Posibles inconsistencias detectadas:</strong>{' '}
                                {res.geminiAnalysis.contradictions.join('; ')}
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

        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="space-y-2 flex-1">
            {hasManualCommercialFieldsInBatch && (
              <div className="bg-purple-50/70 border border-purple-200 rounded-lg p-2.5 flex flex-col sm:flex-row sm:items-center gap-2 text-[11px]">
                <select
                  value={manualCaptureSource}
                  onChange={(e) => setManualCaptureSource(e.target.value as IndependentFieldSource)}
                  className="px-2.5 py-1 border border-purple-300 rounded bg-white text-slate-800"
                >
                  <option value="user_manual_entry">Captura manual verificada del usuario</option>
                  <option value="official_website_html">Web oficial del negocio</option>
                  <option value="authorized_public_source">Fuente empresarial autorizada</option>
                  <option value="phone_call_verified">Corroboración telefónica directa</option>
                </select>
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-purple-950 font-medium">
                  <input
                    type="checkbox"
                    checked={provenanceConfirmed}
                    onChange={(e) => setProvenanceConfirmed(e.target.checked)}
                    className="rounded border-purple-300 text-purple-700 focus:ring-purple-600"
                  />
                  Confirmo procedencia independiente de los campos editados (no copiados de Maps)
                </label>
              </div>
            )}
            {onChangeWorkspaceMode && (
              <div className="inline-flex items-center gap-2 text-xs">
                <span className="font-semibold text-slate-700">Destino CRM:</span>
                <button
                  type="button"
                  onClick={() => onChangeWorkspaceMode('production')}
                  className={`px-2.5 py-1 rounded-md border text-[11px] font-medium ${
                    workspaceMode === 'production'
                      ? 'bg-purple-700 text-white border-purple-700'
                      : 'bg-white text-slate-700 border-slate-300'
                  }`}
                >
                  Producción (followups)
                </button>
                <button
                  type="button"
                  onClick={() => onChangeWorkspaceMode('sandbox')}
                  className={`px-2.5 py-1 rounded-md border text-[11px] font-medium ${
                    workspaceMode === 'sandbox'
                      ? 'bg-emerald-700 text-white border-emerald-700'
                      : 'bg-white text-slate-700 border-slate-300'
                  }`}
                >
                  Espacio Aislado Pruebas (Sandbox)
                </button>
              </div>
            )}
            <div className="text-xs text-slate-600">
              {isSignedIn
                ? `Seleccionados para ${
                    workspaceMode === 'sandbox' ? 'Sandbox Aislado' : 'Seguimiento'
                  }: ${selectedItems.length} (${completeCount} fichas completas). 0 llamadas extra a Places.`
                : 'Inicia sesión con Google para confirmar y guardar preseleccionados en Firebase.'}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 justify-end shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-700 hover:bg-slate-100"
            >
              Cerrar
            </button>
            {onAddSelectedToTemporaryQueue && (
              <button
                type="button"
                disabled={isAnalyzing || selectedItems.length === 0}
                onClick={() => {
                  onAddSelectedToTemporaryQueue(selectedItems.map((i) => i.result.placeId));
                  onClose();
                }}
                className="px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-40 text-white rounded-lg inline-flex items-center gap-1.5"
              >
                <ListPlus className="w-4 h-4" />
                Agregar ({selectedItems.length}) a Seguimiento Temporal (0 Places)
              </button>
            )}
            <button
              type="button"
              disabled={!isSignedIn || isAnalyzing || isSaving || selectedItems.length === 0}
              onClick={handleConfirmWithProvenance}
              className="px-4 py-2 text-xs font-semibold bg-purple-700 hover:bg-purple-800 disabled:opacity-40 text-white rounded-lg inline-flex items-center gap-1.5"
            >
              <CheckCircle2 className="w-4 h-4" />
              {isSaving
                ? 'Guardando en CRM...'
                : workspaceMode === 'sandbox'
                ? `Enviar (${selectedItems.length}) a Sandbox Firestore`
                : `Confirmar y enviar (${selectedItems.length}) a CRM Firestore`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
