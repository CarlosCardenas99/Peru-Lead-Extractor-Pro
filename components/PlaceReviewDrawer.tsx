import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Globe, ShieldCheck, Slash, UserPlus, X } from 'lucide-react';
import {
  BusinessLead,
  FollowupSourceKind,
  IndependentFieldSource,
  PhoneLineType,
  PhoneVerificationStage,
} from '../types';
import { CreateFollowupOutcome } from '../services/firebaseService';
import { corroborateLeadsIndependently } from '../services/geminiService';
import { analyzePeruvianPhone, getPhoneStageLabel } from '../utils/peruPhone';
import {
  buildPersistedVerificationReport,
  encodeVerificationProvenanceEntry,
  evaluateFollowupCompleteness,
  formatIndependentSourceLabel,
  mergeVerificationSources,
  parseVerificationProvenanceEntry,
  PersistedVerificationReport,
  resolveIndependentPhoneType,
  resolveIndependentWebsiteStatusForSave,
} from '../utils/fieldCompliance';
import { computeInformationTrustScore } from '../utils/scoring';

export interface DrawerPromoteIndependentData {
  sourceKind: FollowupSourceKind;
  independentBusinessName: string;
  district: string;
  independentAddress: string;
  independentWebsite: string;
  independentCategory: string;
  confirmedNoWebsite: boolean;
  independentPhone: string;
  independentPhoneType: PhoneLineType;
  phoneStage: PhoneVerificationStage;
  independentEmail: string;
  independentTrustScore: number;
  legalBasis: string;
  notes: string;
  verificationSummary: string;
  lastVerifiedAt: string;
  verificationSources: string[];
}

type ManagedProvenanceField =
  | 'nombre'
  | 'distrito'
  | 'dirección'
  | 'categoría'
  | 'teléfono'
  | 'web'
  | 'correo'
  | 'sin_web';

const MANUAL_SOURCE_OPTIONS: { value: IndependentFieldSource; label: string }[] = [
  { value: 'user_manual_entry', label: 'Captura manual verificada del usuario' },
  { value: 'official_website_html', label: 'Web oficial del comercio (verificación directa)' },
  { value: 'authorized_public_source', label: 'Fuente empresarial autorizada (SUNAT / registro público)' },
  { value: 'phone_call_verified', label: 'Corroboración telefónica directa con el negocio' },
];

interface PlaceReviewDrawerProps {
  lead: BusinessLead | null;
  searchCategory?: string;
  searchDistrict?: string;
  isSignedIn: boolean;
  verifyingPlaceId: string | null;
  onClose: () => void;
  onRunWebsiteCheck: (lead: BusinessLead, overrideUrl?: string) => Promise<void>;
  onUpdateIndependentFields: (
    placeId: string,
    patch: {
      confirmedNoWebsite: boolean;
      independentPhone: string;
      phoneStage: PhoneVerificationStage;
      independentEmail: string;
      independentWebsiteNote: string;
    }
  ) => void;
  onPromoteToFollowup: (
    lead: BusinessLead,
    independentData: DrawerPromoteIndependentData
  ) => Promise<CreateFollowupOutcome>;
  onDiscardPlace: (lead: BusinessLead, reason: string) => Promise<void>;
}

export const PlaceReviewDrawer: React.FC<PlaceReviewDrawerProps> = ({
  lead,
  searchCategory = '',
  searchDistrict = '',
  isSignedIn,
  verifyingPlaceId,
  onClose,
  onRunWebsiteCheck,
  onUpdateIndependentFields,
  onPromoteToFollowup,
  onDiscardPlace,
}) => {
  const initializedPlaceIdRef = useRef<string | null>(null);

  const [independentName, setIndependentName] = useState('');
  const [district, setDistrict] = useState('');
  const [independentAddress, setIndependentAddress] = useState('');
  const [independentWebsite, setIndependentWebsite] = useState('');
  const [independentCategory, setIndependentCategory] = useState('');
  const [confirmedNoWebsite, setConfirmedNoWebsite] = useState(false);
  const [independentPhone, setIndependentPhone] = useState('');
  const [phoneStage, setPhoneStage] = useState<PhoneVerificationStage>('none');
  const [independentEmail, setIndependentEmail] = useState('');
  const [legalBasis, setLegalBasis] = useState('');
  const [notes, setNotes] = useState('');
  const [verificationSources, setVerificationSources] = useState<string[]>([]);
  const [fieldSources, setFieldSources] = useState<Partial<Record<ManagedProvenanceField, IndependentFieldSource>>>({});
  const [manualCaptureSource, setManualCaptureSource] =
    useState<IndependentFieldSource>('user_manual_entry');
  const [provenanceConfirmed, setProvenanceConfirmed] = useState(false);
  const [verificationSummary, setVerificationSummary] = useState('');
  const [lastVerifiedAt, setLastVerifiedAt] = useState('');
  const [discardReason, setDiscardReason] = useState('No califica para diseño web');
  const [saving, setSaving] = useState(false);
  const [corroborating, setCorroborating] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [saveOutcomeReport, setSaveOutcomeReport] = useState<{
    report: PersistedVerificationReport;
    skippedExisting: boolean;
    savedDocId: string;
  } | null>(null);

  useEffect(() => {
    if (!lead) {
      initializedPlaceIdRef.current = null;
      return;
    }
    // Solo inicializar al cambiar de establecimiento (placeId), NUNCA cuando se re-renderiza el mismo lead
    // tras comprobar URL o actualizar puntajes en sesión (evita borrar campos ingresados por el usuario).
    if (initializedPlaceIdRef.current === lead.placeId) {
      return;
    }
    initializedPlaceIdRef.current = lead.placeId;

    const nowIso = new Date().toISOString();
    const cleanDistrict = searchDistrict.replace(/,?\s*per[uú]$/i, '').trim();
    const cleanCategory = (searchCategory || lead.category || '').trim();
    const initialSources: string[] = [];
    const initialFieldSources: Partial<Record<ManagedProvenanceField, IndependentFieldSource>> = {};

    if (cleanDistrict) {
      initialFieldSources.distrito = 'user_search_context';
      initialSources.push(
        encodeVerificationProvenanceEntry({
          field: 'distrito',
          source: 'user_search_context',
          evidence: cleanDistrict,
          verifiedAt: nowIso,
        })
      );
    }
    if (cleanCategory) {
      initialFieldSources.categoría = 'user_search_context';
      initialSources.push(
        encodeVerificationProvenanceEntry({
          field: 'categoría',
          source: 'user_search_context',
          evidence: cleanCategory,
          verifiedAt: nowIso,
        })
      );
    }

    // Cumplimiento ToS: NO prellenar automáticamente displayName/formattedAddress/phone/website de Google Maps como propios.
    setIndependentName('');
    setDistrict(cleanDistrict);
    setIndependentAddress('');
    setIndependentWebsite('');
    setIndependentCategory(cleanCategory);
    setConfirmedNoWebsite(lead.confirmedNoWebsite);
    setIndependentPhone(lead.independentPhone || '');
    setPhoneStage(
      lead.phoneAnalysis.stage === 'independently_corroborated' ||
        lead.phoneAnalysis.stage === 'contact_reached'
        ? lead.phoneAnalysis.stage
        : 'none'
    );
    setIndependentEmail(lead.independentEmail || '');
    setLegalBasis('');
    setNotes(lead.independentWebsiteNote || '');
    setVerificationSources(initialSources);
    setFieldSources(initialFieldSources);
    setManualCaptureSource('user_manual_entry');
    setProvenanceConfirmed(false);
    setVerificationSummary('');
    setLastVerifiedAt(initialSources.length > 0 ? nowIso : '');
    setFeedback(null);
    setSaveOutcomeReport(null);
  }, [lead, searchCategory, searchDistrict]);

  if (!lead) return null;

  const phoneCheck = analyzePeruvianPhone(independentPhone, phoneStage);
  const phoneType = resolveIndependentPhoneType(independentPhone);
  const completeness = evaluateFollowupCompleteness({
    independentBusinessName: independentName,
    independentPhone,
    independentAddress,
    district,
    independentWebsite,
    confirmedNoWebsite,
    independentEmail,
    independentCategory,
  });

  const websiteStatusForSave = resolveIndependentWebsiteStatusForSave({
    independentWebsite,
    confirmedNoWebsite,
    verifiedProbe: lead.websiteProbe,
  });

  const liveTrustScore = computeInformationTrustScore({
    businessStatus: lead.businessStatus,
    independentBusinessName: independentName,
    independentPhone,
    independentAddress,
    district,
    independentWebsite,
    confirmedNoWebsite,
    independentCategory,
    websiteProbe: lead.websiteProbe,
    verificationSourcesCount: verificationSources.length,
    lastVerifiedAt,
  });

  const registerFieldSource = (
    field: ManagedProvenanceField,
    val: string,
    explicitSource?: IndependentFieldSource
  ) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    const sourceToUse =
      explicitSource ||
      (field === 'teléfono' && phoneStage === 'contact_reached'
        ? 'phone_call_verified'
        : manualCaptureSource);

    setFieldSources((prev) => ({ ...prev, [field]: sourceToUse }));
    const nowIso = new Date().toISOString();
    const entry = encodeVerificationProvenanceEntry({
      field,
      source: sourceToUse,
      evidence: trimmed,
      verifiedAt: nowIso,
    });
    setVerificationSources((prev) => mergeVerificationSources(prev, [entry], 8));
    setLastVerifiedAt(nowIso);
  };

  const handleFieldChangeWithProvenance = (
    field: ManagedProvenanceField,
    val: string,
    setter: (v: string) => void
  ) => {
    setter(val);
    setSaveOutcomeReport(null);
    if (val.trim()) {
      setFieldSources((prev) => ({
        ...prev,
        [field]:
          field === 'teléfono' && phoneStage === 'contact_reached'
            ? 'phone_call_verified'
            : manualCaptureSource,
      }));
    }
  };

  const handleCorroborateOfficialWebsite = async () => {
    setCorroborating(true);
    setFeedback(null);
    setSaveOutcomeReport(null);
    try {
      const targetUrl = independentWebsite.trim() || lead.website || null;
      const results = await corroborateLeadsIndependently([
        {
          placeId: lead.placeId,
          officialWebsiteUrl: targetUrl,
          notesText: notes,
          searchCategory: independentCategory || searchCategory || lead.category,
          searchDistrict: district || searchDistrict,
        },
      ]);
      const corr = results[0];
      if (!corr) {
        setFeedback('No se recibieron candidatos de corroboración independiente.');
        return;
      }

      const incoming: string[] = [];
      const nextFieldSources: Partial<Record<ManagedProvenanceField, IndependentFieldSource>> = {};

      const addCandidate = (
        fieldName: ManagedProvenanceField,
        currentVal: string,
        setter: (v: string) => void,
        candidate: {
          value: string;
          source: IndependentFieldSource;
          evidenceUrl: string | null;
          verifiedAt: string;
        } | null
      ) => {
        if (!candidate || !candidate.value) return;
        if (!currentVal.trim()) {
          setter(candidate.value);
          nextFieldSources[fieldName] = candidate.source;
        }
        incoming.push(
          encodeVerificationProvenanceEntry({
            field: fieldName,
            source: candidate.source,
            evidence: candidate.evidenceUrl || candidate.value,
            verifiedAt: candidate.verifiedAt,
          })
        );
      };

      addCandidate('nombre', independentName, setIndependentName, corr.candidates.businessName);
      addCandidate('teléfono', independentPhone, setIndependentPhone, corr.candidates.phone);
      addCandidate('dirección', independentAddress, setIndependentAddress, corr.candidates.address);
      addCandidate('distrito', district, setDistrict, corr.candidates.district);
      addCandidate('web', independentWebsite, setIndependentWebsite, corr.candidates.website);
      addCandidate('correo', independentEmail, setIndependentEmail, corr.candidates.email);
      addCandidate('categoría', independentCategory, setIndependentCategory, corr.candidates.category);

      if (corr.candidates.phone && phoneStage === 'none') {
        setPhoneStage('independently_corroborated');
      }

      setFieldSources((prev) => ({ ...prev, ...nextFieldSources }));
      setVerificationSources((prev) => mergeVerificationSources(prev, incoming, 8));
      setVerificationSummary(corr.summary);
      setLastVerifiedAt(new Date().toISOString());
      setFeedback(`${corr.summary} (0 consultas adicionales a Google Places).`);
    } catch (err: any) {
      setFeedback(err?.message || 'No se pudo corroborar desde el sitio web oficial.');
    } finally {
      setCorroborating(false);
    }
  };

  const handleApplyLocalVerification = () => {
    onUpdateIndependentFields(lead.placeId, {
      confirmedNoWebsite,
      independentPhone,
      phoneStage,
      independentEmail,
      independentWebsiteNote: notes,
    });
    setFeedback(
      'Puntajes e indicadores independientes actualizados en sesión sin perder los campos del formulario.'
    );
  };

  const hasUserManualEntries = (
    [
      ['nombre', independentName],
      ['dirección', independentAddress],
      ['web', independentWebsite],
      ['teléfono', independentPhone],
      ['correo', independentEmail],
    ] as [ManagedProvenanceField, string][]
  ).some(([f, val]) => {
    if (!val.trim()) return false;
    const src = fieldSources[f];
    return src !== 'official_website_jsonld' && src !== 'official_website_html';
  });

  const handlePromote = async () => {
    if (hasUserManualEntries && !provenanceConfirmed) {
      setFeedback(
        'Confirma explícitamente la casilla de procedencia independiente antes de guardar campos ingresados manualmente.'
      );
      return;
    }

    setSaving(true);
    setFeedback(null);
    setSaveOutcomeReport(null);

    const trimmedName = independentName.trim();
    const trimmedPhone = phoneCheck.formatted || independentPhone.trim();
    const trimmedAddr = independentAddress.trim();
    const trimmedWeb = independentWebsite.trim();
    const trimmedCat = independentCategory.trim();
    const trimmedDistrict = district.trim();
    const trimmedEmail = independentEmail.trim();

    const nowIso = new Date().toISOString();
    const resolvedSources: string[] = [];

    const resolveFieldSource = (field: ManagedProvenanceField): IndependentFieldSource => {
      if (fieldSources[field] && fieldSources[field] !== 'none') {
        return fieldSources[field]!;
      }
      if (field === 'teléfono' && phoneStage === 'contact_reached') {
        return 'phone_call_verified';
      }
      if (field === 'distrito' || field === 'categoría') {
        return 'user_search_context';
      }
      return manualCaptureSource === 'none' ? 'user_manual_entry' : manualCaptureSource;
    };

    const appendProvenance = (field: ManagedProvenanceField, evidence: string) => {
      if (!evidence) return;
      resolvedSources.push(
        encodeVerificationProvenanceEntry({
          field,
          source: resolveFieldSource(field),
          evidence,
          verifiedAt: nowIso,
        })
      );
    };

    appendProvenance('nombre', trimmedName);
    appendProvenance('teléfono', trimmedPhone);
    appendProvenance('dirección', trimmedAddr);
    appendProvenance('distrito', trimmedDistrict);
    appendProvenance('web', trimmedWeb);
    appendProvenance('correo', trimmedEmail);
    appendProvenance('categoría', trimmedCat);
    if (confirmedNoWebsite) {
      appendProvenance('sin_web', 'Confirmado sin sitio web propio');
    }

    const mergedSources = mergeVerificationSources(resolvedSources, verificationSources, 8);
    const hasOwnCommercialName = trimmedName.length > 0;
    const isManualWithoutPlaceId = !lead.placeId || lead.placeId.startsWith('manual_');
    const sourceKind: FollowupSourceKind =
      hasOwnCommercialName || isManualWithoutPlaceId
        ? 'independent_manual'
        : 'places_preselection';

    try {
      const outcome = await onPromoteToFollowup(lead, {
        sourceKind,
        independentBusinessName: trimmedName,
        district: trimmedDistrict,
        independentAddress: trimmedAddr,
        independentWebsite: trimmedWeb,
        independentCategory: trimmedCat,
        confirmedNoWebsite,
        independentPhone: trimmedPhone,
        independentPhoneType: resolveIndependentPhoneType(trimmedPhone),
        phoneStage:
          trimmedPhone
            ? phoneStage === 'none'
              ? 'independently_corroborated'
              : phoneStage
            : lead.phoneAnalysis.stage,
        independentEmail: trimmedEmail,
        independentTrustScore: liveTrustScore.score,
        legalBasis: legalBasis.trim(),
        notes: notes.trim(),
        verificationSummary:
          verificationSummary ||
          (completeness.status === 'complete'
            ? 'Ficha comercial completa preparada y verificada en Firestore.'
            : 'Ficha parcial preparada en revisión manual.'),
        lastVerifiedAt: lastVerifiedAt || nowIso,
        verificationSources: mergedSources,
      });

      const report = outcome.persistedRecord
        ? buildPersistedVerificationReport(outcome.persistedRecord)
        : buildPersistedVerificationReport({
            independentBusinessName: '',
            independentPhone: '',
            independentAddress: '',
            district: '',
            independentWebsite: '',
            independentWebsiteStatus: 'unregistered',
            confirmedNoWebsite: false,
            independentEmail: '',
            independentCategory: '',
          });

      setSaveOutcomeReport({
        report,
        skippedExisting: outcome.skippedExisting,
        savedDocId: outcome.id,
      });

      if (outcome.skippedExisting) {
        setFeedback(
          'Este Place ID ya existía en Seguimiento CRM. Se conservaron intactos su etapa, notas, base legal y fecha de creación sin sobrescribir.'
        );
      } else if (report.isComplete) {
        setFeedback(
          'Guardado y re-leído desde servidor Firestore: ficha comercial persistente completa verificada (4/4).'
        );
      } else {
        setFeedback(
          `Guardado en Firestore como FICHA INCOMPLETA (${report.status}). Revisa el detalle exacto de campos faltantes abajo.`
        );
      }
    } catch (err: any) {
      setFeedback(err?.message || 'Error al guardar en CRM.');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = async () => {
    setSaving(true);
    try {
      await onDiscardPlace(lead, discardReason);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const urlToProbe = independentWebsite.trim() || lead.website;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/40"
      role="dialog"
      aria-modal="true"
      aria-label="Revisión manual de establecimiento"
    >
      <div className="w-full max-w-xl bg-white h-full overflow-y-auto shadow-xl border-l border-slate-200 flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4 sticky top-0 bg-white z-10">
          <div>
            <div className="text-xs font-semibold text-purple-700">
              Preparar Ficha para Seguimiento · Revisión y Procedencia
            </div>
            <h2 className="text-lg font-semibold text-slate-900 mt-0.5">{lead.name}</h2>
            <div className="text-xs text-slate-500 font-mono-tabular mt-0.5">
              Place ID: {lead.placeId}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"
            aria-label="Cerrar panel"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6 flex-1">
          {/* Section A: Google Maps Read-Only Reference */}
          <section className="border border-slate-200 rounded-xl p-4 bg-slate-50/70">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-xs font-semibold text-slate-700">
                1. Referencia Google Places API (Solo sesión Explorador · Nunca se copia automáticamente a Firestore)
              </h3>
              <a
                href={lead.mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-purple-700 hover:underline inline-flex items-center gap-1 font-medium"
              >
                Ver en Maps
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-slate-500">Dirección en Maps (solo presentación)</dt>
                <dd className="text-slate-900 font-medium mt-0.5">{lead.address}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Estado operativo / Rubro Maps</dt>
                <dd className="text-slate-900 font-medium mt-0.5">
                  {lead.businessStatus || 'No informado'} · {lead.primaryTypeLabel || lead.category}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Calificación y reseñas (solo contexto)</dt>
                <dd className="text-slate-900 font-mono-tabular mt-0.5">
                  ★ {lead.rating} · {lead.reviews} reseñas
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Teléfono en Google (solo presentación)</dt>
                <dd className="text-slate-900 font-mono-tabular mt-0.5">
                  {lead.phone} ({lead.phoneAnalysis.note})
                </dd>
              </div>
            </dl>
          </section>

          {/* Section B: 3 Independent Scores Breakdown */}
          <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="border border-slate-200 rounded-xl p-3.5">
              <div className="text-[11px] text-slate-500">1. Necesidad Digital</div>
              <div className="text-xl font-semibold text-purple-800 font-mono-tabular mt-1">
                {lead.digitalScore.score}/100
              </div>
              <div className="text-xs font-medium text-slate-800 mt-0.5">
                {lead.digitalScore.label}
              </div>
              <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
                {lead.digitalScore.reasons.map((r, idx) => (
                  <li key={idx}>• {r}</li>
                ))}
              </ul>
            </div>

            <div className="border border-slate-200 rounded-xl p-3.5">
              <div className="text-[11px] text-slate-500">2. Calidad de Contacto</div>
              <div className="text-xl font-semibold text-slate-900 font-mono-tabular mt-1">
                {lead.contactabilityScore.score}/100
              </div>
              <div className="text-xs font-medium text-slate-800 mt-0.5">
                {lead.contactabilityScore.label}
              </div>
              <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
                {lead.contactabilityScore.reasons.map((r, idx) => (
                  <li key={idx}>• {r}</li>
                ))}
              </ul>
            </div>

            <div className="border border-slate-200 rounded-xl p-3.5">
              <div className="text-[11px] text-slate-500">3. Confianza de Info</div>
              <div
                className={`text-xl font-semibold font-mono-tabular mt-1 ${
                  liveTrustScore.hasContradictions
                    ? 'text-rose-700'
                    : liveTrustScore.score >= 75
                    ? 'text-emerald-700'
                    : 'text-slate-800'
                }`}
              >
                {liveTrustScore.score}/100
              </div>
              <div className="text-xs font-medium text-slate-800 mt-0.5">
                {liveTrustScore.label}
              </div>
              {liveTrustScore.contradictions.length > 0 && (
                <div className="mt-1.5 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
                  {liveTrustScore.contradictions.join(' ')}
                </div>
              )}
              <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
                {liveTrustScore.reasons.map((r, idx) => (
                  <li key={idx}>• {r}</li>
                ))}
              </ul>
            </div>
          </section>

          {/* Section C: Independent Verification & Corroboration */}
          <section className="border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold text-slate-800">
                  2. Preparar Ficha Persistente WEBNEX ({completeness.label})
                </h3>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {urlToProbe && (
                  <button
                    type="button"
                    disabled={corroborating}
                    onClick={handleCorroborateOfficialWebsite}
                    className="px-3 py-1.5 text-xs font-semibold bg-purple-700 text-white rounded-lg hover:bg-purple-800 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <Globe className="w-3.5 h-3.5" />
                    {corroborating ? 'Corroborando...' : 'Corroborar Web Oficial (0 Places)'}
                  </button>
                )}
                {urlToProbe && (
                  <button
                    type="button"
                    disabled={verifyingPlaceId === lead.placeId}
                    onClick={() => onRunWebsiteCheck(lead, urlToProbe)}
                    className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5"
                  >
                    <ShieldCheck className="w-3.5 h-3.5 text-purple-700" />
                    {verifyingPlaceId === lead.placeId ? 'Verificando HTTP...' : 'Comprobar URL (SSRF-safe)'}
                  </button>
                )}
              </div>
            </div>

            <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
              <div className="font-semibold text-slate-800">
                Estado Web a guardar: <span className="font-mono-tabular">{websiteStatusForSave}</span> ({lead.websiteProbe.summary})
              </div>
              {independentWebsite.trim() && websiteStatusForSave === 'unverified_inconclusive' && (
                <div className="text-amber-800">
                  URL ingresada manualmente registrada con estado <strong>unverified_inconclusive</strong> hasta completar comprobación HTTP SSRF-safe (no se descarta ni se marca activa sin prueba).
                </div>
              )}
              {independentWebsite.trim() && websiteStatusForSave === 'invalid_url' && (
                <div className="text-rose-700">
                  La URL ingresada tiene formato inválido (se guardará como <strong>invalid_url</strong> para corrección).
                </div>
              )}
              {lead.websiteProbe.inconclusiveReason && (
                <div className="text-amber-800">
                  Resultado clasificado como NO VERIFICADO: {lead.websiteProbe.inconclusiveReason}
                </div>
              )}
              {completeness.missingFields.length > 0 && (
                <div className="text-amber-800">
                  Campos persistentes por completar para Firestore: {completeness.missingFields.join(', ')}
                </div>
              )}
            </div>

            {/* Origen explícito declarado para campos capturados manualmente */}
            <div className="bg-purple-50/50 border border-purple-200 rounded-lg p-3 space-y-2 text-xs">
              <div>
                <label className="block font-semibold text-purple-950 mb-1">
                  Procedencia autorizada de los datos ingresados / verificados
                </label>
                <select
                  value={manualCaptureSource}
                  onChange={(e) => setManualCaptureSource(e.target.value as IndependentFieldSource)}
                  className="w-full px-3 py-1.5 text-xs border border-purple-300 rounded-lg bg-white"
                >
                  {MANUAL_SOURCE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-start gap-2 text-[11px] text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={provenanceConfirmed}
                  onChange={(e) => setProvenanceConfirmed(e.target.checked)}
                  className="mt-0.5 rounded border-purple-300 text-purple-700 focus:ring-purple-600"
                />
                <span>
                  Confirmo explícitamente que los campos comerciales ingresados provienen de la fuente independiente declarada (web oficial, fuente empresarial autorizada o captura propia) y no se copiaron automáticamente de Google Maps.
                </span>
              </label>
            </div>

            <label className="flex items-center gap-2 text-xs font-medium text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmedNoWebsite}
                onChange={(e) => {
                  setConfirmedNoWebsite(e.target.checked);
                  setSaveOutcomeReport(null);
                  if (e.target.checked) {
                    registerFieldSource('sin_web', 'Confirmado sin sitio web propio');
                  }
                }}
                className="rounded border-slate-300 text-purple-700 focus:ring-purple-600"
              />
              Confirmado manualmente que el negocio NO tiene sitio web propio
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Nombre comercial independiente / web oficial
                </label>
                <input
                  type="text"
                  value={independentName}
                  onChange={(e) =>
                    handleFieldChangeWithProvenance('nombre', e.target.value, setIndependentName)
                  }
                  onBlur={() => registerFieldSource('nombre', independentName)}
                  placeholder="Solo desde web oficial o captura propia"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Distrito / Zona
                </label>
                <input
                  type="text"
                  value={district}
                  onChange={(e) =>
                    handleFieldChangeWithProvenance('distrito', e.target.value, setDistrict)
                  }
                  onBlur={() => registerFieldSource('distrito', district)}
                  placeholder="Ej: Los Olivos"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Dirección corroborada / propia
                </label>
                <input
                  type="text"
                  value={independentAddress}
                  onChange={(e) =>
                    handleFieldChangeWithProvenance(
                      'dirección',
                      e.target.value,
                      setIndependentAddress
                    )
                  }
                  onBlur={() => registerFieldSource('dirección', independentAddress)}
                  placeholder="Av. / Jr. / Calle (web oficial o captura propia)"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Categoría comercial propia
                </label>
                <input
                  type="text"
                  value={independentCategory}
                  onChange={(e) =>
                    handleFieldChangeWithProvenance(
                      'categoría',
                      e.target.value,
                      setIndependentCategory
                    )
                  }
                  onBlur={() => registerFieldSource('categoría', independentCategory)}
                  placeholder="Ej: Veterinarias"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Teléfono corroborado ({phoneType})
                </label>
                <input
                  type="text"
                  value={independentPhone}
                  onChange={(e) =>
                    handleFieldChangeWithProvenance('teléfono', e.target.value, setIndependentPhone)
                  }
                  onBlur={() => registerFieldSource('teléfono', independentPhone)}
                  placeholder="+51 9XX XXX XXX"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono-tabular"
                />
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {phoneCheck.isValidFormat ? `Formato válido: ${phoneCheck.formatted}` : phoneCheck.note}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Estado de verificación telefónica
                </label>
                <select
                  value={phoneStage}
                  onChange={(e) => setPhoneStage(e.target.value as PhoneVerificationStage)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="none">{getPhoneStageLabel('none')}</option>
                  <option value="registered_invalid">{getPhoneStageLabel('registered_invalid')}</option>
                  <option value="registered_valid_format">{getPhoneStageLabel('registered_valid_format')}</option>
                  <option value="independently_corroborated">{getPhoneStageLabel('independently_corroborated')}</option>
                  <option value="contact_reached">{getPhoneStageLabel('contact_reached')}</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Sitio web oficial corroborado
                </label>
                <input
                  type="url"
                  value={independentWebsite}
                  onChange={(e) =>
                    handleFieldChangeWithProvenance('web', e.target.value, setIndependentWebsite)
                  }
                  onBlur={() => registerFieldSource('web', independentWebsite)}
                  placeholder="https://empresa.pe"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Correo electrónico independiente
                </label>
                <input
                  type="email"
                  value={independentEmail}
                  onChange={(e) =>
                    handleFieldChangeWithProvenance('correo', e.target.value, setIndependentEmail)
                  }
                  onBlur={() => registerFieldSource('correo', independentEmail)}
                  placeholder="contacto@empresa.pe"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Base legal / consentimiento (opcional en preselección)
              </label>
              <input
                type="text"
                value={legalBasis}
                onChange={(e) => setLegalBasis(e.target.value)}
                placeholder="Evidencia de autorización de contacto"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Notas de verificación y hallazgos
              </label>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Evidencia verificada..."
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>

            {verificationSources.length > 0 && (
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                {verificationSources.map((raw, idx) => {
                  const parsed = parseVerificationProvenanceEntry(raw);
                  return (
                    <span
                      key={idx}
                      className="px-2 py-0.5 bg-slate-100 border border-slate-200 rounded text-slate-700"
                      title={parsed.evidence}
                    >
                      {parsed.field}: {formatIndependentSourceLabel(parsed.source)}
                    </span>
                  );
                })}
              </div>
            )}

            {feedback && (
              <div
                className={`text-xs rounded-lg px-3 py-2 border ${
                  saveOutcomeReport && !saveOutcomeReport.report.isComplete
                    ? 'text-amber-950 bg-amber-50 border-amber-300'
                    : 'text-purple-900 bg-purple-50 border-purple-200'
                }`}
              >
                {feedback}
              </div>
            )}

            {saveOutcomeReport && (
              <div
                className={`text-xs rounded-lg p-3 border space-y-1.5 ${
                  saveOutcomeReport.report.isComplete
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
                    : 'bg-amber-50 border-amber-300 text-amber-950'
                }`}
              >
                <div className="font-semibold flex items-center gap-1.5">
                  {saveOutcomeReport.report.isComplete ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                  )}
                  Lectura directa confirmada desde Firestore ({saveOutcomeReport.savedDocId}) — Estado:{' '}
                  {saveOutcomeReport.report.status}
                </div>
                <div className="text-[11px] font-mono-tabular break-words">
                  {saveOutcomeReport.report.persistedCoreSummary}
                </div>
                {saveOutcomeReport.report.missingReasons.length > 0 && (
                  <ul className="text-[11px] space-y-0.5 pt-1 border-t border-amber-200">
                    {saveOutcomeReport.report.missingReasons.map((reason, idx) => (
                      <li key={idx}>• {reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-2">
              <button
                type="button"
                onClick={handleApplyLocalVerification}
                className="px-3 py-2 text-xs font-medium border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50"
              >
                Actualizar puntajes en sesión
              </button>
              <button
                type="button"
                disabled={saving || !isSignedIn}
                onClick={handlePromote}
                className="px-4 py-2 text-xs font-semibold bg-purple-700 text-white rounded-lg hover:bg-purple-800 disabled:opacity-50 inline-flex items-center gap-1.5"
                title={!isSignedIn ? 'Inicia sesión con Google para guardar en Firestore' : ''}
              >
                <UserPlus className="w-3.5 h-3.5" />
                {saving
                  ? 'Guardando y verificando...'
                  : isSignedIn
                  ? 'Guardar en Seguimiento CRM'
                  : 'Inicia sesión para guardar en CRM'}
              </button>
            </div>
          </section>

          {/* Section D: Discard */}
          <section className="border border-slate-200 rounded-xl p-4 bg-slate-50/50">
            <h3 className="text-xs font-semibold text-slate-800 mb-2">
              Descartar establecimiento (solo persiste Place ID y motivo)
            </h3>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={discardReason}
                onChange={(e) => setDiscardReason(e.target.value)}
                placeholder="Motivo del descarte"
                className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              />
              <button
                type="button"
                disabled={saving}
                onClick={handleDiscard}
                className="px-3 py-2 text-xs font-medium text-rose-700 border border-rose-300 bg-white hover:bg-rose-50 rounded-lg inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <Slash className="w-3.5 h-3.5" />
                Marcar como Descartado
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
