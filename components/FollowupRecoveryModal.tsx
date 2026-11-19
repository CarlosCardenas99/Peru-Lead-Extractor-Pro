import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  Globe,
  SearchCheck,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  FollowupLeadRecord,
  IndependentCorroborationResult,
} from '../types';
import { MissingFieldRecoveryProposal } from '../services/firebaseService';
import { corroborateLeadsIndependently } from '../services/geminiService';
import { analyzePeruvianPhone } from '../utils/peruPhone';
import {
  encodeVerificationProvenanceEntry,
  evaluateFollowupCompleteness,
  resolveIndependentPhoneType,
} from '../utils/fieldCompliance';

export interface RecoveryCandidatePreview {
  record: FollowupLeadRecord;
  proposal: MissingFieldRecoveryProposal;
  fieldsToFill: Array<{ label: string; value: string; sourceLabel: string }>;
}

interface FollowupRecoveryModalProps {
  isOpen: boolean;
  followups: FollowupLeadRecord[];
  onClose: () => void;
  onRecoverMissingFields: (
    proposals: MissingFieldRecoveryProposal[]
  ) => Promise<{ updatedRecords: number; skippedRecords: number; fieldsCompleted: number }>;
}

function extractFirstUrlFromOwnFields(record: FollowupLeadRecord): string | null {
  if (record.independentWebsite?.trim()) {
    return record.independentWebsite.trim();
  }
  const combined = `${record.notes || ''} ${record.aiSummary || ''}`;
  const match = combined.match(/https?:\/\/[^\s<>"')]+/i);
  if (!match) return null;
  const candidate = match[0];
  if (/(maps\.google\.|google\.com\/maps|facebook\.com|instagram\.com|tiktok\.com|wa\.me)/i.test(candidate)) {
    return null;
  }
  return candidate;
}

export function parseAuthorizedCsvRows(
  rawText: string
): Array<{
  placeId: string;
  businessName?: string;
  phone?: string;
  address?: string;
  district?: string;
  website?: string;
  email?: string;
  category?: string;
}> {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const rows: Array<{
    placeId: string;
    businessName?: string;
    phone?: string;
    address?: string;
    district?: string;
    website?: string;
    email?: string;
    category?: string;
  }> = [];

  for (let i = 0; i < lines.length; i++) {
    const sep = lines[i].includes('\t') ? '\t' : lines[i].includes(';') ? ';' : ',';
    const cols = lines[i].split(sep).map((c) => c.replace(/^["']|["']$/g, '').trim());
    if (i === 0 && /place.?id/i.test(cols[0] || '')) {
      continue;
    }
    const placeId = cols[0] || '';
    if (!placeId) continue;
    rows.push({
      placeId,
      businessName: cols[1] || '',
      phone: cols[2] || '',
      address: cols[3] || '',
      district: cols[4] || '',
      website: cols[5] || '',
      email: cols[6] || '',
      category: cols[7] || '',
    });
  }

  return rows;
}

export function buildNonDestructiveRecoveryPreviews(params: {
  followups: FollowupLeadRecord[];
  corroborations: IndependentCorroborationResult[];
  authorizedCsvText?: string;
  nowIso?: string;
}): RecoveryCandidatePreview[] {
  const nowIso = params.nowIso || new Date().toISOString();
  const corrByPlaceId = new Map<string, IndependentCorroborationResult>();
  for (const c of params.corroborations) {
    corrByPlaceId.set(c.placeId, c);
  }

  const csvRows = parseAuthorizedCsvRows(params.authorizedCsvText || '');
  const csvByPlaceId = new Map<string, (typeof csvRows)[number]>();
  for (const r of csvRows) {
    csvByPlaceId.set(r.placeId, r);
  }

  const previews: RecoveryCandidatePreview[] = [];

  for (const record of params.followups) {
    if (record.stage === 'CLIENTE') continue;

    const corr = corrByPlaceId.get(record.placeId);
    const csv = csvByPlaceId.get(record.placeId) || csvByPlaceId.get(record.id);

    const proposal: MissingFieldRecoveryProposal = {
      id: record.id,
      verificationSources: [],
      lastVerifiedAt: nowIso,
    };
    const fieldsToFill: RecoveryCandidatePreview['fieldsToFill'] = [];

    const considerField = (
      existingVal: string | undefined,
      csvVal: string | undefined,
      corrCand: { value: string; source: any; evidenceUrl: string | null; verifiedAt: string } | null | undefined,
      targetKey: Exclude<
        keyof MissingFieldRecoveryProposal,
        'id' | 'independentPhoneType' | 'verificationSummary' | 'lastVerifiedAt' | 'verificationSources'
      >,
      fieldLabel: string
    ) => {
      if ((existingVal || '').trim()) return; // NUNCA proponer sobrescribir campo existente

      if (corrCand && corrCand.value.trim()) {
        proposal[targetKey] = corrCand.value.trim();
        proposal.verificationSources!.push(
          encodeVerificationProvenanceEntry({
            field: fieldLabel.toLowerCase(),
            source: corrCand.source,
            evidence: corrCand.evidenceUrl || corrCand.value,
            verifiedAt: corrCand.verifiedAt || nowIso,
          })
        );
        fieldsToFill.push({
          label: fieldLabel,
          value: corrCand.value.trim(),
          sourceLabel: corrCand.evidenceUrl ? `Web oficial (${corrCand.evidenceUrl})` : 'Web oficial',
        });
        return;
      }

      if (csvVal && csvVal.trim()) {
        let finalVal = csvVal.trim();
        if (targetKey === 'independentPhone') {
          const parsed = analyzePeruvianPhone(finalVal);
          finalVal = parsed.formatted || finalVal;
          proposal.independentPhoneType = parsed.lineType;
        }
        proposal[targetKey] = finalVal;
        proposal.verificationSources!.push(
          encodeVerificationProvenanceEntry({
            field: fieldLabel.toLowerCase(),
            source: 'authorized_public_source',
            evidence: 'Carga autorizada en asistente de recuperación',
            verifiedAt: nowIso,
          })
        );
        fieldsToFill.push({
          label: fieldLabel,
          value: finalVal,
          sourceLabel: 'Archivo/Fuente autorizada del usuario',
        });
      }
    };

    considerField(
      record.independentBusinessName,
      csv?.businessName,
      corr?.candidates.businessName,
      'independentBusinessName',
      'Nombre comercial'
    );
    considerField(
      record.independentPhone,
      csv?.phone,
      corr?.candidates.phone,
      'independentPhone',
      'Teléfono'
    );
    if (proposal.independentPhone && !proposal.independentPhoneType) {
      proposal.independentPhoneType = resolveIndependentPhoneType(
        proposal.independentPhone,
        corr?.candidates.phoneType?.value
      );
    }
    considerField(
      record.independentAddress,
      csv?.address,
      corr?.candidates.address,
      'independentAddress',
      'Dirección'
    );
    considerField(
      record.district,
      csv?.district,
      corr?.candidates.district,
      'district',
      'Distrito'
    );
    considerField(
      record.independentWebsite,
      csv?.website,
      corr?.candidates.website,
      'independentWebsite',
      'Sitio web'
    );
    considerField(
      record.independentEmail,
      csv?.email,
      corr?.candidates.email,
      'independentEmail',
      'Correo'
    );
    considerField(
      record.independentCategory,
      csv?.category,
      corr?.candidates.category,
      'independentCategory',
      'Categoría'
    );

    if (fieldsToFill.length > 0) {
      proposal.verificationSummary = `Recuperación no destructiva (${fieldsToFill
        .map((f) => f.label)
        .join(', ')}) sin consultas a Google Places.`;
      previews.push({ record, proposal, fieldsToFill });
    }
  }

  return previews;
}

export const FollowupRecoveryModal: React.FC<FollowupRecoveryModalProps> = ({
  isOpen,
  followups,
  onClose,
  onRecoverMissingFields,
}) => {
  const [authorizedCsvText, setAuthorizedCsvText] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [scanDone, setScanDone] = useState(false);
  const [previews, setPreviews] = useState<RecoveryCandidatePreview[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [resultBanner, setResultBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const audit = useMemo(() => {
    let complete = 0;
    let partial = 0;
    let placeIdOnly = 0;
    let missingName = 0;
    let missingPhone = 0;
    let missingAddress = 0;
    let missingWebsiteInfo = 0;
    let recoverableUrlCount = 0;

    for (const r of followups) {
      const comp = evaluateFollowupCompleteness(r);
      if (comp.status === 'complete') complete += 1;
      else if (comp.status === 'partial') partial += 1;
      else placeIdOnly += 1;

      if (!r.independentBusinessName?.trim()) missingName += 1;
      if (!r.independentPhone?.trim()) missingPhone += 1;
      if (!r.independentAddress?.trim()) missingAddress += 1;
      if (!r.independentWebsite?.trim() && !r.confirmedNoWebsite) missingWebsiteInfo += 1;
      if (extractFirstUrlFromOwnFields(r)) recoverableUrlCount += 1;
    }

    return {
      total: followups.length,
      complete,
      partial,
      placeIdOnly,
      missingName,
      missingPhone,
      missingAddress,
      missingWebsiteInfo,
      recoverableUrlCount,
    };
  }, [followups]);

  if (!isOpen) return null;

  const handleRunPermittedScan = async () => {
    setIsScanning(true);
    setErrorBanner(null);
    setResultBanner(null);

    try {
      const urlTargets = followups
        .filter((r) => r.stage !== 'CLIENTE')
        .map((r) => ({
          record: r,
          url: extractFirstUrlFromOwnFields(r),
        }))
        .filter((item): item is { record: FollowupLeadRecord; url: string } => Boolean(item.url));

      const corroborations =
        urlTargets.length > 0
          ? await corroborateLeadsIndependently(
              urlTargets.map(({ record, url }) => ({
                placeId: record.placeId,
                officialWebsiteUrl: url,
                notesText: record.notes,
                searchCategory: record.independentCategory || '',
                searchDistrict: record.district || '',
              }))
            )
          : [];

      const built = buildNonDestructiveRecoveryPreviews({
        followups,
        corroborations,
        authorizedCsvText,
      });
      setPreviews(built);
      setSelectedDocIds(new Set(built.map((b) => b.record.id)));
      setScanDone(true);
    } catch (err: any) {
      setErrorBanner(err?.message || 'Error al analizar fuentes independientes.');
    } finally {
      setIsScanning(false);
    }
  };

  const handleApplyRecovery = async () => {
    const chosen = previews
      .filter((p) => selectedDocIds.has(p.record.id))
      .map((p) => p.proposal);
    if (chosen.length === 0) return;

    setIsApplying(true);
    setErrorBanner(null);
    try {
      const outcome = await onRecoverMissingFields(chosen);
      setResultBanner(
        `Recuperación transaccional completada: ${outcome.updatedRecords} fichas enriquecidas (${outcome.fieldsCompleted} campos vacíos completados, ${outcome.skippedRecords} sin cambios). Etapas, notas, base legal y fechas de creación se mantuvieron 100% intactas.`
      );
      setPreviews([]);
      setSelectedDocIds(new Set());
      setScanDone(false);
    } catch (err: any) {
      setErrorBanner(err?.message || 'Error al aplicar recuperación transaccional en Firestore.');
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Asistente de recuperación no destructiva de fichas"
    >
      <div className="bg-white border border-slate-200 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold text-purple-700 inline-flex items-center gap-1.5">
              <DatabaseBackup className="w-3.5 h-3.5" />
              Recuperación No Destructiva · 0 consultas a Google Places
            </div>
            <h2 className="text-lg font-semibold text-slate-900 mt-0.5">
              Auditoría y Completado de Fichas Existentes ({audit.total} registros en Firebase)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Completa exclusivamente campos vacíos desde sitios web oficiales o fuentes autorizadas cargadas por ti. Nunca borra documentos ni altera etapas, notas, base legal o datos previos.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"
            aria-label="Cerrar asistente"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-5 text-xs">
          {/* Paso 1: Auditoría actual */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="font-semibold text-slate-800 flex items-center gap-1.5">
              <SearchCheck className="w-4 h-4 text-purple-700" />
              Paso 1: Diagnóstico en vivo de colección Firestore (users/uid/followups)
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono-tabular">
              <div className="bg-white border border-slate-200 rounded-lg p-2.5">
                <div className="text-[11px] text-slate-500 font-sans">Total registros</div>
                <div className="text-lg font-semibold text-slate-900">{audit.total}</div>
              </div>
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2.5">
                <div className="text-[11px] text-emerald-800 font-sans">Fichas completas</div>
                <div className="text-lg font-semibold text-emerald-900">{audit.complete}</div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                <div className="text-[11px] text-amber-800 font-sans">Parciales</div>
                <div className="text-lg font-semibold text-amber-900">{audit.partial}</div>
              </div>
              <div className="bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                <div className="text-[11px] text-rose-800 font-sans">Solo Place ID</div>
                <div className="text-lg font-semibold text-rose-900">{audit.placeIdOnly}</div>
              </div>
            </div>
            <div className="text-slate-600 flex flex-wrap gap-x-4 gap-y-1">
              <span>Sin nombre propio: <strong>{audit.missingName}</strong></span>
              <span>Sin teléfono propio: <strong>{audit.missingPhone}</strong></span>
              <span>Sin dirección propia: <strong>{audit.missingAddress}</strong></span>
              <span>Con URL oficial detectable en ficha/notas: <strong>{audit.recoverableUrlCount}</strong></span>
            </div>
          </div>

          {/* Paso 2: Fuentes permitidas */}
          <div className="border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="font-semibold text-slate-800 flex items-center gap-1.5">
              <Globe className="w-4 h-4 text-purple-700" />
              Paso 2: Buscar en fuentes independientes permitidas (sin consultar Google Places)
            </div>
            <p className="text-slate-600">
              Además de analizar automáticamente las URLs oficiales guardadas en tus fichas/notas, puedes pegar aquí registros de tu propia cartera/fuente autorizada (1 fila por registro: <code className="bg-slate-100 px-1 rounded">placeId,nombre,telefono,direccion,distrito,web,correo,categoria</code>) para completar los campos vacíos por coincidencia exacta de Place ID.
            </p>
            <textarea
              rows={4}
              value={authorizedCsvText}
              onChange={(e) => setAuthorizedCsvText(e.target.value)}
              placeholder="ChIJ_ejemplo,Veterinaria Santa Rosa,+51 987 654 321,Av. Universitaria 1200,Los Olivos,https://vetsantarosa.pe,hola@vetsantarosa.pe,Veterinarias"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono-tabular text-xs"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-500">
                Garantía: 0 llamadas a Google Places API. No se enviarán ni se escribirán datos sin tu confirmación en el Paso 3.
              </span>
              <button
                type="button"
                disabled={isScanning || followups.length === 0}
                onClick={handleRunPermittedScan}
                className="px-4 py-2 font-semibold bg-purple-700 text-white rounded-lg hover:bg-purple-800 disabled:opacity-50 whitespace-nowrap"
              >
                {isScanning ? 'Analizando fuentes...' : 'Buscar coincidencias permitidas'}
              </button>
            </div>
          </div>

          {errorBanner && (
            <div className="bg-red-50 border border-red-200 text-red-900 rounded-lg p-3 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorBanner}</span>
            </div>
          )}

          {resultBanner && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-3 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{resultBanner}</span>
            </div>
          )}

          {/* Paso 3: Revisión lado a lado */}
          {scanDone && (
            <div className="border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-700" />
                  Paso 3: Revisar coincidencias antes de escribir ({previews.length} registros con campos recuperables)
                </div>
                {previews.length > 0 && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedDocIds(new Set(previews.map((p) => p.record.id)))}
                      className="text-purple-700 hover:underline font-medium"
                    >
                      Marcar todos
                    </button>
                    <span className="text-slate-300">|</span>
                    <button
                      type="button"
                      onClick={() => setSelectedDocIds(new Set())}
                      className="text-slate-600 hover:underline"
                    >
                      Desmarcar todos
                    </button>
                  </div>
                )}
              </div>

              {previews.length === 0 ? (
                <div className="text-slate-500 py-4 text-center bg-slate-50 rounded-lg">
                  No se encontraron nuevos campos en URLs oficiales registradas ni en CSV autorizado para completar campos vacíos. Puedes editar manualmente cualquier ficha desde la tabla principal sin consumir cuota Places.
                </div>
              ) : (
                <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                  {previews.map((item) => {
                    const checked = selectedDocIds.has(item.record.id);
                    return (
                      <div
                        key={item.record.id}
                        className="border border-slate-200 rounded-lg p-3 bg-slate-50/50 flex items-start gap-3"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setSelectedDocIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(item.record.id)) next.delete(item.record.id);
                              else next.add(item.record.id);
                              return next;
                            })
                          }
                          className="mt-1 rounded border-slate-300 text-purple-700"
                        />
                        <div className="flex-1 space-y-1">
                          <div className="font-semibold text-slate-900">
                            {item.record.independentBusinessName || `Place ID: ${item.record.placeId}`}{' '}
                            <span className="font-normal text-slate-500">
                              ({item.record.stage})
                            </span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                            {item.fieldsToFill.map((f, idx) => (
                              <div
                                key={idx}
                                className="bg-white border border-emerald-200 rounded px-2 py-1 text-[11px]"
                              >
                                <span className="font-semibold text-emerald-900">{f.label}:</span>{' '}
                                <span className="text-slate-900">{f.value}</span>
                                <div className="text-[10px] text-slate-500">Origen: {f.sourceLabel}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            Solo se actualizan campos vacíos mediante transacción en Firestore.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-700 hover:bg-slate-100"
            >
              Cerrar
            </button>
            {previews.length > 0 && (
              <button
                type="button"
                disabled={isApplying || selectedDocIds.size === 0}
                onClick={handleApplyRecovery}
                className="px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-40 text-white rounded-lg inline-flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-4 h-4" />
                {isApplying
                  ? 'Aplicando cambios...'
                  : `Confirmar y completar (${selectedDocIds.size}) fichas`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
