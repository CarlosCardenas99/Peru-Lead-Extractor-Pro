import React, { useEffect, useState } from 'react';
import { ExternalLink, ShieldCheck, Slash, UserPlus, X } from 'lucide-react';
import {
  BusinessLead,
  FollowupSourceKind,
  PhoneVerificationStage,
} from '../types';
import { analyzePeruvianPhone, getPhoneStageLabel } from '../utils/peruPhone';

interface PlaceReviewDrawerProps {
  lead: BusinessLead | null;
  isSignedIn: boolean;
  verifyingPlaceId: string | null;
  onClose: () => void;
  onRunWebsiteCheck: (lead: BusinessLead) => Promise<void>;
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
    independentData: {
      sourceKind: FollowupSourceKind;
      independentBusinessName: string;
      district: string;
      confirmedNoWebsite: boolean;
      independentPhone: string;
      phoneStage: PhoneVerificationStage;
      independentEmail: string;
      legalBasis: string;
      notes: string;
    }
  ) => Promise<void>;
  onDiscardPlace: (lead: BusinessLead, reason: string) => Promise<void>;
}

export const PlaceReviewDrawer: React.FC<PlaceReviewDrawerProps> = ({
  lead,
  isSignedIn,
  verifyingPlaceId,
  onClose,
  onRunWebsiteCheck,
  onUpdateIndependentFields,
  onPromoteToFollowup,
  onDiscardPlace,
}) => {
  const [independentName, setIndependentName] = useState('');
  const [district, setDistrict] = useState('');
  const [confirmedNoWebsite, setConfirmedNoWebsite] = useState(false);
  const [independentPhone, setIndependentPhone] = useState('');
  const [phoneStage, setPhoneStage] = useState<PhoneVerificationStage>('none');
  const [independentEmail, setIndependentEmail] = useState('');
  const [legalBasis, setLegalBasis] = useState('');
  const [notes, setNotes] = useState('');
  const [discardReason, setDiscardReason] = useState('No califica para diseño web');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!lead) return;
    // Cumplimiento ToS: NO prellenar automáticamente datos de Google Maps en campos persistentes de CRM.
    setIndependentName('');
    setDistrict('');
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
    setFeedback(null);
  }, [lead]);

  if (!lead) return null;

  const phoneCheck = analyzePeruvianPhone(independentPhone, phoneStage);

  const handleApplyLocalVerification = () => {
    onUpdateIndependentFields(lead.placeId, {
      confirmedNoWebsite,
      independentPhone,
      phoneStage,
      independentEmail,
      independentWebsiteNote: notes,
    });
    setFeedback('Verificación independiente actualizada en sesión.');
  };

  const handlePromote = async () => {
    setSaving(true);
    setFeedback(null);
    const trimmedName = independentName.trim();
    const sourceKind: FollowupSourceKind = trimmedName ? 'independent_manual' : 'places_preselection';
    try {
      await onPromoteToFollowup(lead, {
        sourceKind,
        independentBusinessName: trimmedName,
        district: district.trim(),
        confirmedNoWebsite,
        independentPhone: phoneCheck.formatted || independentPhone.trim(),
        phoneStage:
          trimmedName || independentPhone.trim()
            ? phoneStage
            : lead.phoneAnalysis.stage,
        independentEmail: independentEmail.trim(),
        legalBasis: legalBasis.trim(),
        notes: notes.trim(),
      });
      setFeedback(
        sourceKind === 'places_preselection'
          ? 'Guardado en Seguimiento CRM como referencia por Place ID + metadatos propios (sin persistir datos de Maps).'
          : 'Guardado en Seguimiento CRM con datos independientes verificados.'
      );
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
              Revisión Manual y Procedencia
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
                1. Datos de Google Places API (Solo sesión · No exportable)
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
                <dt className="text-slate-500">Dirección registrada</dt>
                <dd className="text-slate-900 font-medium mt-0.5">{lead.address}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Estado operativo / Rubro</dt>
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
                <dt className="text-slate-500">Teléfono en Google</dt>
                <dd className="text-slate-900 font-mono-tabular mt-0.5">
                  {lead.phone} ({lead.phoneAnalysis.note})
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[11px] text-slate-500">
              Nota: Tener teléfono, muchas reseñas o buena calificación no demuestra intención de compra ni presencia de WhatsApp.
            </p>
          </section>

          {/* Section B: Dual Independent Scores Breakdown */}
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Oportunidad Digital (Separada)</div>
              <div className="text-2xl font-semibold text-purple-800 font-mono-tabular mt-1">
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

            <div className="border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Contactabilidad (Separada)</div>
              <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">
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
          </section>

          {/* Section C: Independent Verification */}
          <section className="border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-slate-800">
                2. Verificación Independiente WEBNEX
              </h3>
              {lead.website && (
                <button
                  type="button"
                  disabled={verifyingPlaceId === lead.placeId}
                  onClick={() => onRunWebsiteCheck(lead)}
                  className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-purple-700" />
                  {verifyingPlaceId === lead.placeId ? 'Verificando HTTP...' : 'Comprobar URL (SSRF-safe)'}
                </button>
              )}
            </div>

            <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3">
              <div className="font-semibold text-slate-800">
                Estado Web: {lead.websiteProbe.summary}
              </div>
              {lead.websiteProbe.inconclusiveReason && (
                <div className="text-amber-800 mt-1">
                  Resultado clasificado como NO VERIFICADO: {lead.websiteProbe.inconclusiveReason}
                </div>
              )}
            </div>

            <label className="flex items-center gap-2 text-xs font-medium text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmedNoWebsite}
                onChange={(e) => setConfirmedNoWebsite(e.target.checked)}
                className="rounded border-slate-300 text-purple-700 focus:ring-purple-600"
              />
              Confirmado manualmente que el negocio NO tiene sitio web propio
            </label>

            <p className="text-[11px] text-slate-500">
              Si dejas los campos de identificación vacíos, al guardar en CRM se almacenará únicamente el <strong>Place ID</strong> y los metadatos propios (los detalles de Maps se hidratan en vivo en pantalla). Llena los campos manualmente solo con datos obtenidos de forma independiente.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Nombre independiente (opcional)
                </label>
                <input
                  type="text"
                  value={independentName}
                  onChange={(e) => setIndependentName(e.target.value)}
                  placeholder="Solo si fue capturado fuera de Maps"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Distrito / Zona independiente
                </label>
                <input
                  type="text"
                  value={district}
                  onChange={(e) => setDistrict(e.target.value)}
                  placeholder="Ej: Los Olivos"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Teléfono corroborado independientemente
                </label>
                <input
                  type="text"
                  value={independentPhone}
                  onChange={(e) => setIndependentPhone(e.target.value)}
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
                  Correo electrónico independiente
                </label>
                <input
                  type="email"
                  value={independentEmail}
                  onChange={(e) => setIndependentEmail(e.target.value)}
                  placeholder="contacto@empresa.pe"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Base legal / consentimiento (si aplica)
                </label>
                <input
                  type="text"
                  value={legalBasis}
                  onChange={(e) => setLegalBasis(e.target.value)}
                  placeholder="Opcional en preselección"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Notas de verificación y hallazgos
              </label>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Evidencia verificada (ej. se validó en directorio/redes que no cuenta con web propia)..."
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>

            {feedback && (
              <div className="text-xs text-purple-800 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">
                {feedback}
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
                {isSignedIn ? 'Guardar en Seguimiento CRM' : 'Inicia sesión para guardar en CRM'}
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
