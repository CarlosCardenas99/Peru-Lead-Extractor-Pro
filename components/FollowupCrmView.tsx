import React, { useMemo, useState } from 'react';
import {
  FOLLOWUP_STAGES,
  FollowupLeadRecord,
  FollowupStage,
  PhoneVerificationStage,
} from '../types';
import { getPhoneStageLabel } from '../utils/peruPhone';
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
        'stage' | 'phoneStage' | 'independentPhone' | 'independentEmail' | 'notes' | 'confirmedNoWebsite'
      >
    >
  ) => Promise<void>;
  onCreateManualFollowup: (payload: {
    independentBusinessName: string;
    district: string;
    confirmedNoWebsite: boolean;
    independentPhone: string;
    phoneStage: PhoneVerificationStage;
    independentEmail: string;
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
  const [draftNotes, setDraftNotes] = useState('');
  const [draftPhone, setDraftPhone] = useState('');
  const [draftEmail, setDraftEmail] = useState('');
  const [showManualForm, setShowManualForm] = useState(false);

  const [manualName, setManualName] = useState('');
  const [manualDistrict, setManualDistrict] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [manualConfirmedNoWeb, setManualConfirmedNoWeb] = useState(true);
  const [manualNotes, setManualNotes] = useState('');

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return followups.filter((item) => {
      if (stageFilter !== 'all' && item.stage !== stageFilter) return false;
      if (!q) return true;
      return (
        item.independentBusinessName.toLowerCase().includes(q) ||
        item.district.toLowerCase().includes(q) ||
        item.independentPhone.toLowerCase().includes(q) ||
        item.notes.toLowerCase().includes(q)
      );
    });
  }, [followups, stageFilter, searchTerm]);

  if (!isSignedIn) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
        <h2 className="text-lg font-semibold text-slate-900">
          Seguimiento Comercial Privado (Firebase Firestore)
        </h2>
        <p className="text-sm text-slate-600 mt-2 max-w-lg mx-auto">
          Inicia sesión con Google para gestionar tus prospectos verificados independientemente bajo reglas estrictas por UID autorizado. No se permite acceso público a registros comerciales.
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
      notes: manualNotes.trim(),
    });
    setManualName('');
    setManualDistrict('');
    setManualPhone('');
    setManualEmail('');
    setManualNotes('');
    setShowManualForm(false);
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Módulo de Seguimiento Comercial (Datos Independientes)
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Almacena únicamente datos recopilados independientemente y capturados por el usuario. Sin mensajería masiva automática.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          placeholder="Filtrar seguimiento por nombre, distrito, teléfono o notas..."
          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-sm text-slate-500">
          No hay registros de seguimiento para el filtro seleccionado. Selecciona un negocio en el Explorador y usa &ldquo;Guardar en Seguimiento CRM&rdquo;.
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
              <tr>
                <th className="py-3 px-4">Empresa / Distrito</th>
                <th className="py-3 px-3">Estado Comercial (8 etapas)</th>
                <th className="py-3 px-3">Contacto Independiente</th>
                <th className="py-3 px-3 text-right">Puntajes Indep.</th>
                <th className="py-3 px-4">Notas y Gestión</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {filtered.map((item) => {
                const isEditing = editingId === item.id;
                const isClientLocked = item.stage === 'Cliente';
                return (
                  <tr key={item.id} className="hover:bg-slate-50 align-top">
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900">
                        {item.independentBusinessName}
                      </div>
                      <div className="text-slate-500 mt-0.5">{item.district || 'Perú'}</div>
                      <div className="text-[11px] text-slate-500 mt-1">
                        {item.confirmedNoWebsite
                          ? 'Confirmado sin web'
                          : `Estado web: ${item.independentWebsiteStatus}`}
                      </div>
                    </td>

                    <td className="py-3 px-3">
                      <select
                        value={item.stage}
                        disabled={isClientLocked}
                        onChange={(e) =>
                          onUpdateFollowup(item.id, {
                            stage: e.target.value as FollowupStage,
                          })
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
                          Cliente confirmado (etapa bloqueada)
                        </div>
                      )}
                    </td>

                    <td className="py-3 px-3">
                      {isEditing && !isClientLocked ? (
                        <div className="space-y-1.5">
                          <input
                            type="text"
                            value={draftPhone}
                            onChange={(e) => setDraftPhone(e.target.value)}
                            placeholder="Teléfono"
                            className="w-full px-2 py-1 border border-slate-300 rounded text-xs font-mono-tabular"
                          />
                          <input
                            type="email"
                            value={draftEmail}
                            onChange={(e) => setDraftEmail(e.target.value)}
                            placeholder="Correo"
                            className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                          />
                        </div>
                      ) : (
                        <div>
                          <div className="font-mono-tabular text-slate-900">
                            {item.independentPhone || 'Sin teléfono'}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {getPhoneStageLabel(item.phoneStage)}
                          </div>
                          {item.independentEmail && (
                            <div className="text-[11px] text-purple-700 mt-0.5">
                              {item.independentEmail}
                            </div>
                          )}
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
                                        notes: draftNotes,
                                        independentPhone: draftPhone,
                                        independentEmail: draftEmail,
                                      }
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
                          <p className="text-slate-600 whitespace-pre-wrap break-words">
                            {item.notes || 'Sin notas'}
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(item.id);
                              setDraftNotes(item.notes);
                              setDraftPhone(item.independentPhone);
                              setDraftEmail(item.independentEmail);
                            }}
                            className="mt-1 text-purple-700 hover:underline font-medium"
                          >
                            Editar notas / contacto
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
