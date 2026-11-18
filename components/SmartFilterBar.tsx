import React from 'react';
import { Filter, Sparkles } from 'lucide-react';
import { SmartFilterState } from '../types';

interface SmartFilterBarProps {
  filters: SmartFilterState;
  onChange: (next: SmartFilterState) => void;
  onReset: () => void;
  totalLoaded: number;
  filteredCount: number;
  isAnalyzing: boolean;
  onRunAutoQualifier: () => void;
}

const FILTER_OPTIONS: Array<{
  key: keyof SmartFilterState;
  label: string;
}> = [
  { key: 'mobileOnly', label: 'Solo celulares peruanos' },
  { key: 'excludeLandlines', label: 'Excluir teléfonos fijos' },
  { key: 'mobileAndNoWebsite', label: 'Con teléfono móvil y sin web registrada' },
  { key: 'socialOnly', label: 'Solo redes sociales' },
  { key: 'corroboratedWebFailure', label: 'Página web con fallos corroborados' },
  { key: 'pendingVerification', label: 'Pendientes de verificación' },
  {
    key: 'excludeClientsDiscardsDuplicates',
    label: 'Excluir clientes, descartados y duplicados',
  },
];

export const SmartFilterBar: React.FC<SmartFilterBarProps> = ({
  filters,
  onChange,
  onReset,
  totalLoaded,
  filteredCount,
  isAnalyzing,
  onRunAutoQualifier,
}) => {
  const activeCount = FILTER_OPTIONS.filter((o) => filters[o.key]).length;

  return (
    <section
      aria-label="Filtros inteligentes y cualificación automática WEBNEX"
      className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-sm"
    >
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-slate-100">
        <div className="flex items-start gap-2.5">
          <Filter className="w-4 h-4 text-purple-700 mt-0.5 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Filtros Inteligentes Combinables · WEBNEX Smart Lead Qualifier
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Un formato peruano válido no demuestra que el número esté activo, pertenezca al propietario o tenga WhatsApp.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {activeCount > 0 && (
            <button
              type="button"
              onClick={onReset}
              className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg bg-slate-50"
            >
              Reiniciar filtros
            </button>
          )}
          <button
            type="button"
            disabled={totalLoaded === 0 || isAnalyzing}
            onClick={onRunAutoQualifier}
            className="px-4 py-2.5 text-xs font-semibold bg-purple-700 hover:bg-purple-800 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg inline-flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            <Sparkles className="w-4 h-4" />
            {isAnalyzing
              ? 'Analizando resultados cargados...'
              : 'Analizar y preseleccionar para seguimiento'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {FILTER_OPTIONS.map((opt) => {
          const checked = filters[opt.key];
          return (
            <label
              key={opt.key}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs cursor-pointer transition-colors ${
                checked
                  ? 'bg-purple-50 border-purple-300 text-purple-900 font-medium'
                  : 'bg-slate-50/70 border-slate-200 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) =>
                  onChange({
                    ...filters,
                    [opt.key]: e.target.checked,
                  })
                }
                className="rounded border-slate-300 text-purple-700 focus:ring-purple-600 shrink-0"
              />
              <span className="leading-snug">{opt.label}</span>
            </label>
          );
        })}
      </div>

      {totalLoaded > 0 && (
        <div className="text-[11px] text-slate-500 font-mono-tabular pt-1">
          Mostrando {filteredCount} de {totalLoaded} negocios únicos cargados en sesión (el análisis automático evalúa los {totalLoaded} resultados completos, sin limitarse a la página actual).
        </div>
      )}
    </section>
  );
};
