import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  AUTHORIZED_OUTREACH_STAGES,
  FOLLOWUP_STAGES,
  FollowupLeadRecord,
  FollowupStage,
  HydratedPlaceDetails,
  PhoneVerificationStage,
} from '../types';
import { getPhoneStageLabel } from '../utils/peruPhone';
import { validateLegalBasisForStage } from '../utils/leadQualifier';
import { fetchPlaceDetailsBatch } from '../services/geminiService';
import { ExportButton } from './ExportButton';

interface FollowupCrmViewProps {
  isSignedIn: boolean;
  followups: FollowupLeadRecord[];
  onSignIn: () => void;
  onUpdateFollowup: (
    id: string,
    updates: Partial<
      Pick<
        FollowupLeadRecord,
        | 'independentBusinessName'
        | 'district'
        | 'stage'
        | 'legalBasis'
        | 'phoneStage'
        | 'independentPhone'
        | 'independentEmail'
        | 'notes'
        | 'confirmedNoWebsite'
      >
    >,
    currentRecord?: FollowupLeadRecord
  ) => Promise<void>;
  onCreateManualFollowup: (payload: {
    independentBusinessName: string;
    district: string;
    confirmedNoWebsite: boolean;
    independentPhone: string;
    phoneStage: PhoneVerificationStage;
    independentEmail: string;
    legalBasis: string;
    notes: string;
  }) => Promise<void>;
}

export const FollowupCrmView: React.FC<FollowupCrmViewProps> = ({
  isSignedIn,
  followups,
  onSignIn,
  onUpdateFollowup,
  onCreateManualFollowup,
}) => {
  const [stageFilter, setStageFilter] = useState<'all' | FollowupStage>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftDistrict, setDraftDistrict] = useState('');
  const [draftPhone, setDraftPhone] = useState('');
  const [draftEmail, setDraftEmail] = useState('');
  const [draftLegalBasis, setDraftLegalBasis] = useState('');
  const [draftNotes, setDraftNotes] = useState('');

  // Pending authorization prompt when user selects CONTACTO AUTORIZADO / CONTACTADO without legalBasis
  const [authPrompt, setAuthPrompt] = useState<{
    record: FollowupLeadRecord;
    targetStage: FollowupStage;
    legalBasisInput: string;
    error: string | null;
  } | null>(null);

  const [showManualForm, setShowManualForm] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualDistrict, setManualDistrict] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [manualConfirmedNoWeb, setManualConfirmedNoWeb] = useState(true);
  const [manualNotes, setManualNotes] = useState('');

  // Live session-only Place Details hydration (never stored in Firestore or exported to CSV)
  const [hydratedPlaces, setHydratedPlaces] = useState<Record<string, HydratedPlaceDetails>>({});
  const [isHydrating, setIsHydrating] = useState(false);

  const missingPlaceIdsToHydrate = useMemo(
    () =>
      followups
        .filter(
          (f) =>
            f.placeId &&
            !f.placeId.startsWith('manual_') &&
            !hydratedPlaces[f.placeId]
        )
        .map((f) => f.placeId)
        .slice(0, 10),
    [followups, hydratedPlaces]
  );

  const handleHydrateVisiblePlaces = async () => {
    if (missingPlaceIdsToHydrate.length === 0) return;
    setIsHydrating(true);
    try {
      const res = await fetchPlaceDetailsBatch(missingPlaceIdsToHydrate);
      if (Object.keys(res.details).length > 0) {
        setHydratedPlaces((prev) => ({ ...prev, ...res.details }));
      }
    } finally {
      setIsHydrating(false);
    }
  };

  useEffect(() => {
    if (isSignedIn && missingPlaceIdsToHydrate.length > 0 && !isHydrating) {
      handleHydrateVisiblePlaces();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, missingPlaceIdsToHydrate.length]);

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return followups.filter((item) => {
      if (stageFilter !== 'all' && item.stage !== stageFilter) return false;
      if (!q) return true;
      const hydrated = hydratedPlaces[item.placeId];
      return (
        item.independentBusinessName.toLowerCase().includes(q) ||
        item.district.toLowerCase().includes(q) ||
        item.independentPhone.toLowerCase().includes(q) ||
        item.placeId.toLowerCase().includes(q) ||
        item.notes.toLowerCase().includes(q) ||
        (hydrated?.displayName || '').toLowerCase().includes(q)
      );
    });
  }, [followups, stageFilter, searchTerm, hydratedPlaces]);

  if (!isSignedIn) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
        <h2 className="text-lg font-semibold text-slate-900">
          Seguimiento Comercial Privado (Firebase Firestore)
        </h2>
        <p className="text-sm text-slate-600 mt-2 max-w-lg mx-auto">
          Inicia sesión con Google para gestionar tus prospectos preseleccionados y registros independientes bajo reglas estrictas por UID autorizado. No se permite acceso público.
        </p>
        <button
          type="button"
          onClick={onSignIn}
          className="mt-5 px-5 py-2.5 text-sm font-semibold bg-purple-700 text-white rounded-lg hover:bg-purple-800 transition-colors"
        >
          Iniciar sesión con Google
        </button>
      </div>
    );
  }

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualName.trim()) return;
    await onCreateManualFollowup({
      independentBusinessName: manualName.trim(),
      district: manualDistrict.trim(),
      confirmedNoWebsite: manualConfirmedNoWeb,
      independentPhone: manualPhone.trim(),
      phoneStage: manualPhone.trim() ? 'independently_corroborated' : 'none',
      independentEmail: manualEmail.trim(),
      legalBasis: '',
      notes: manualNotes.trim(),
    });
    setManualName('');
    setManualDistrict('');
    setManualPhone('');
    setManualEmail('');
    setManualNotes('');
    setShowManualForm(false);
  };

  const handleStageChange = async (item: FollowupLeadRecord, nextStage: FollowupStage) => {
    if (AUTHORIZED_OUTREACH_STAGES.has(nextStage)) {
      const gateError = validateLegalBasisForStage(nextStage, item.legalBasis);
      if (gateError) {
        setAuthPrompt({
          record: item,
          targetStage: nextStage,
          legalBasisInput: item.legalBasis || '',
          error: null,
        });
        return;
      }
    }
    await onUpdateFollowup(item.id, { stage: nextStage }, item);
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Módulo de Seguimiento Comercial (9 Etapas y Base Legal Verificada)
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Los registros preseleccionados guardan únicamente Place ID y metadatos propios; los detalles de Maps se muestran en vivo solo en sesión y nunca se exportan.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {missingPlaceIdsToHydrate.length > 0 && (
            <button
              type="button"
              disabled={isHydrating}
              onClick={handleHydrateVisiblePlaces}
              className="px-3 py-2 text-xs font-medium border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isHydrating ? 'animate-spin' : ''}`} />
              Hidratar Places ({missingPlaceIdsToHydrate.length})
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowManualForm((v) => !v)}
            className="px-3 py-2 text-xs font-medium border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50"
          >
            {showManualForm ? 'Cerrar registro manual' : 'Agregar registro independiente'}
          </button>
          <ExportButton followups={filtered} />
        </div>
      </div>

      {authPrompt && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 space-y-3">
          <div className="flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-amber-800 mt-0.5 shrink-0" />
            <div className="text-xs text-amber-950">
              <div className="font-semibold">
                Autorización de Contacto Requerida para pasar a &ldquo;{authPrompt.targetStage}&rdquo;
              </div>
              <p className="mt-0.5">
                La preselección automática NO autoriza llamadas ni mensajes comerciales. Registra la evidencia verificable de consentimiento previo o base legal aplicable antes de autorizar el contacto.
              </p>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={authPrompt.legalBasisInput}
              onChange={(e) =>
                setAuthPrompt({ ...authPrompt, legalBasisInput: e.target.value, error: null })
              }
              placeholder="Ej: Solicitud recibida por formulario web / Referido directo B2B verificado (mín. 8 caracteres)"
              className="flex-1 px-3 py-2 text-xs border border-amber-300 rounded-lg bg-white"
            />
            <button
              type="button"
              onClick={async () => {
                const err = validateLegalBasisForStage(
                  authPrompt.targetStage,
                  authPrompt.legalBasisInput
                );
                if (err) {
                  setAuthPrompt({ ...authPrompt, error: err });
                  return;
                }
                await onUpdateFollowup(
                  authPrompt.record.id,
                  {
                    stage: authPrompt.targetStage,
                    legalBasis: authPrompt.legalBasisInput.trim(),
                  },
                  authPrompt.record
                );
                setAuthPrompt(null);
              }}
              className="px-4 py-2 text-xs font-semibold bg-purple-700 text-white rounded-lg hover:bg-purple-800 whitespace-nowrap"
            >
              Autorizar y actualizar etapa
            </button>
            <button
              type="button"
              onClick={() => setAuthPrompt(null)}
              className="px-3 py-2 text-xs border border-slate-300 bg-white rounded-lg"
            >
              Cancelar
            </button>
          </div>
          {authPrompt.error && (
            <div className="text-xs text-red-700 font-medium">{authPrompt.error}</div>
          )}
        </div>
      )}

      {showManualForm && (
        <form
          onSubmit={handleManualSubmit}
          className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 md:grid-cols-3 gap-4"
        >
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Nombre comercial (ingresado manualmente)
            </label>
            <input
              type="text"
              required
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Distrito / Ciudad
            </label>
            <input
              type="text"
              value={manualDistrict}
              onChange={(e) => setManualDistrict(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Teléfono corroborado
            </label>
            <input
              type="text"
              value={manualPhone}
              onChange={(e) => setManualPhone(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono-tabular"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Correo independiente
            </label>
            <input
              type="email"
              value={manualEmail}
              onChange={(e) => setManualEmail(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-700 mb-1">Notas</label>
            <input
              type="text"
              value={manualNotes}
              onChange={(e) => setManualNotes(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div className="md:col-span-3 flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={manualConfirmedNoWeb}
                onChange={(e) => setManualConfirmedNoWeb(e.target.checked)}
              />
              Confirmado sin sitio web propio
            </label>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold bg-purple-700 text-white rounded-lg hover:bg-purple-800"
            >
              Guardar en CRM
            </button>
          </div>
        </form>
      )}

      {/* Stage segmented filter + search */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setStageFilter('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              stageFilter === 'all'
                ? 'bg-purple-700 text-white border-purple-700'
                : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
            }`}
          >
            Todos ({followups.length})
          </button>
          {FOLLOWUP_STAGES.map((stage) => {
            const count = followups.filter((f) => f.stage === stage).length;
            return (
              <button
                key={stage}
                type="button"
                onClick={() => setStageFilter(stage)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                  stageFilter === stage
                    ? 'bg-purple-700 text-white border-purple-700'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {stage} ({count})
              </button>
            );
          })}
        </div>

        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Filtrar seguimiento por nombre, Place ID, distrito, teléfono o notas..."
          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-sm text-slate-500">
          No hay registros de seguimiento para el filtro seleccionado. Usa &ldquo;Analizar y preseleccionar para seguimiento&rdquo; en el Explorador o agrega un registro independiente.
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
              <tr>
                <th className="py-3 px-4">Empresa / Referencia Place ID</th>
                <th className="py-3 px-3">Estado Comercial (9 etapas)</th>
                <th className="py-3 px-3">Contacto Independiente y Autorización</th>
                <th className="py-3 px-3 text-right">Puntajes</th>
                <th className="py-3 px-4">Notas y Gestión</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {filtered.map((item) => {
                const isEditing = editingId === item.id;
                const isClientLocked = item.stage === 'CLIENTE';
                const hydrated = hydratedPlaces[item.placeId];
                const displayName =
                  item.independentBusinessName ||
                  hydrated?.displayName ||
                  `Place ID: ${item.placeId}`;
                const displaySub = item.independentBusinessName
                  ? item.district || 'Registro independiente'
                  : hydrated
                  ? `${hydrated.formattedAddress} (Ref. Places en vivo · No exportable)`
                  : 'Solo Place ID persistido (clic en Hidratar Places)';

                return (
                  <tr key={item.id} className="hover:bg-slate-50 align-top">
                    <td className="py-3 px-4 max-w-[260px]">
                      <div className="font-semibold text-slate-900">{displayName}</div>
                      <div className="text-slate-500 mt-0.5 text-[11px]">{displaySub}</div>
                      <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap items-center gap-2">
                        <span>
                          {item.confirmedNoWebsite
                            ? 'Confirmado sin web'
                            : `Web: ${item.independentWebsiteStatus}`}
                        </span>
                        {item.qualificationTier && (
                          <span className="font-semibold text-purple-800">
                            · {item.qualificationTier}
                          </span>
                        )}
                      </div>
                      {hydrated?.googleMapsUri && (
                        <a
                          href={hydrated.googleMapsUri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-purple-700 hover:underline mt-1"
                        >
                          Ver en Google Maps
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </td>

                    <td className="py-3 px-3">
                      <select
                        value={item.stage}
                        disabled={isClientLocked}
                        onChange={(e) =>
                          handleStageChange(item, e.target.value as FollowupStage)
                        }
                        className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white disabled:bg-slate-100"
                      >
                        {FOLLOWUP_STAGES.map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
                      {isClientLocked && (
                        <div className="text-[10px] text-emerald-700 mt-1">
                          CLIENTE confirmado (etapa bloqueada)
                        </div>
                      )}
                    </td>

                    <td className="py-3 px-3">
                      {isEditing && !isClientLocked ? (
                        <div className="space-y-1.5">
                          <input
                            type="text"
                            value={draftName}
                            onChange={(e) => setDraftName(e.target.value)}
                            placeholder="Nombre comercial independiente"
                            className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                          />
                          <input
                            type="text"
                            value={draftDistrict}
                            onChange={(e) => setDraftDistrict(e.target.value)}
                            placeholder="Distrito independiente"
                            className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                          />
                          <input
                            type="text"
                            value={draftPhone}
                            onChange={(e) => setDraftPhone(e.target.value)}
                            placeholder="Teléfono corroborado"
                            className="w-full px-2 py-1 border border-slate-300 rounded text-xs font-mono-tabular"
                          />
                          <input
                            type="email"
                            value={draftEmail}
                            onChange={(e) => setDraftEmail(e.target.value)}
                            placeholder="Correo independiente"
                            className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                          />
                          <input
                            type="text"
                            value={draftLegalBasis}
                            onChange={(e) => setDraftLegalBasis(e.target.value)}
                            placeholder="Base legal / evidencia consentimiento"
                            className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                          />
                        </div>
                      ) : (
                        <div>
                          <div className="font-mono-tabular text-slate-900">
                            {item.independentPhone ||
                              (hydrated?.nationalPhoneNumber
                                ? `Ref. Places: ${hydrated.nationalPhoneNumber}`
                                : 'Sin teléfono independiente')}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {getPhoneStageLabel(item.phoneStage)}
                          </div>
                          {item.independentEmail && (
                            <div className="text-[11px] text-purple-700 mt-0.5">
                              {item.independentEmail}
                            </div>
                          )}
                          <div className="text-[11px] mt-1 text-slate-600">
                            Base legal:{' '}
                            {item.legalBasis ? (
                              <span className="text-emerald-800 font-medium">
                                {item.legalBasis}
                              </span>
                            ) : (
                              <span className="text-amber-700">Sin autorización aún</span>
                            )}
                          </div>
                        </div>
                      )}
                    </td>

                    <td className="py-3 px-3 text-right font-mono-tabular">
                      <div className="text-purple-800 font-semibold">
                        Dig: {item.independentDigitalScore}/100
                      </div>
                      <div className="text-slate-600 mt-0.5">
                        Cont: {item.independentContactScore}/100
                      </div>
                    </td>

                    <td className="py-3 px-4 max-w-xs">
                      {isEditing ? (
                        <div className="space-y-2">
                          <textarea
                            rows={2}
                            value={draftNotes}
                            onChange={(e) => setDraftNotes(e.target.value)}
                            className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={async () => {
                                await onUpdateFollowup(
                                  item.id,
                                  isClientLocked
                                    ? { notes: draftNotes }
                                    : {
                                        independentBusinessName: draftName,
                                        district: draftDistrict,
                                        notes: draftNotes,
                                        independentPhone: draftPhone,
                                        independentEmail: draftEmail,
                                        legalBasis: draftLegalBasis,
                                      },
                                  item
                                );
                                setEditingId(null);
                              }}
                              className="px-2.5 py-1 bg-purple-700 text-white rounded text-xs font-medium"
                            >
                              Guardar
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="px-2.5 py-1 border border-slate-300 rounded text-xs"
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          {item.aiSummary && (
                            <p className="text-[11px] text-purple-900 bg-purple-50 border border-purple-100 rounded p-1.5 mb-1.5">
                              {item.aiSummary}
                            </p>
                          )}
                          <p className="text-slate-600 whitespace-pre-wrap break-words">
                            {item.notes || 'Sin notas'}
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(item.id);
                              setDraftName(item.independentBusinessName);
                              setDraftDistrict(item.district);
                              setDraftNotes(item.notes);
                              setDraftPhone(item.independentPhone);
                              setDraftEmail(item.independentEmail);
                              setDraftLegalBasis(item.legalBasis);
                            }}
                            className="mt-1 text-purple-700 hover:underline font-medium"
                          >
                            Editar datos / autorización
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
