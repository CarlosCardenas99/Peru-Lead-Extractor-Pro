import React, { useState } from 'react';
import { MapPin, Search, Sparkles } from 'lucide-react';
import { QuotaStatus, SearchParams, WebsiteFilterOption } from '../types';

interface SearchFormProps {
  onSearch: (params: SearchParams) => void;
  onSuggestSubzones: (location: string, businessType: string) => Promise<void>;
  isLoading: boolean;
  isLoadingSubzones: boolean;
  subzones: string[];
  subzoneRationale: string;
  subzoneError: string | null;
  quota: QuotaStatus | null;
  websiteFilter: WebsiteFilterOption;
  onWebsiteFilterChange: (filter: WebsiteFilterOption) => void;
}

export const SearchForm: React.FC<SearchFormProps> = ({
  onSearch,
  onSuggestSubzones,
  isLoading,
  isLoadingSubzones,
  subzones,
  subzoneRationale,
  subzoneError,
  quota,
  websiteFilter,
  onWebsiteFilterChange,
}) => {
  const [params, setParams] = useState<Omit<SearchParams, 'websiteFilter'>>({
    businessType: '',
    location: '',
    maxReviews: 0,
    subzone: '',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (params.businessType.trim() && params.location.trim()) {
      onSearch({
        ...params,
        businessType: params.businessType.trim(),
        location: params.location.trim(),
        websiteFilter,
      });
    }
  };

  const handleSubzoneClick = (zone: string) => {
    const nextZone = params.subzone === zone ? '' : zone;
    setParams((prev) => ({ ...prev, subzone: nextZone }));
    if (params.businessType.trim() && params.location.trim() && nextZone) {
      onSearch({
        ...params,
        businessType: params.businessType.trim(),
        location: params.location.trim(),
        subzone: nextZone,
        websiteFilter,
      });
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm"
    >
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 pb-4 mb-5 border-b border-slate-100">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Búsqueda Estructurada · Places API (New)
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Campos seleccionados mínimos, paginación manual y deduplicación por Place ID.
          </p>
        </div>
        {quota && (
          <div className="text-xs font-mono-tabular text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 whitespace-nowrap">
            Cuota hoy ({quota.dateLima}): Places {quota.placesUsed}/{quota.placesLimit} · Gemini {quota.geminiUsed}/{quota.geminiLimit}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <label
            htmlFor="business-type-input"
            className="block text-xs font-semibold text-slate-700 mb-1.5"
          >
            Rubro o Tipo de Negocio
          </label>
          <input
            id="business-type-input"
            type="text"
            placeholder="Ej: Clínicas dentales, Ferreterías..."
            className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-purple-600 focus:border-purple-600 outline-none transition-colors"
            value={params.businessType}
            onChange={(e) => setParams({ ...params, businessType: e.target.value })}
            disabled={isLoading}
            required
          />
        </div>

        <div>
          <label
            htmlFor="location-input"
            className="block text-xs font-semibold text-slate-700 mb-1.5"
          >
            Ubicación (Perú)
          </label>
          <input
            id="location-input"
            type="text"
            placeholder="Ej: Los Olivos, Lima o Arequipa"
            className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-purple-600 focus:border-purple-600 outline-none transition-colors"
            value={params.location}
            onChange={(e) => setParams({ ...params, location: e.target.value })}
            disabled={isLoading}
            required
          />
        </div>

        <div>
          <label
            htmlFor="website-filter-select"
            className="block text-xs font-semibold text-slate-700 mb-1.5"
          >
            Filtro por Estado Web
          </label>
          <select
            id="website-filter-select"
            value={websiteFilter}
            onChange={(e) => onWebsiteFilterChange(e.target.value as WebsiteFilterOption)}
            className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-purple-600 focus:border-purple-600 outline-none transition-colors"
          >
            <option value="all">Todos los estados</option>
            <option value="no_website_any">Sin web o confirmado sin web</option>
            <option value="unregistered">Solo sin web registrada</option>
            <option value="confirmed_none">Solo confirmados sin web</option>
            <option value="social_only">Solo red social / enlace básico</option>
            <option value="unreachable_verified">Web caída verificada</option>
            <option value="unverified_inconclusive">No verificado (inconcluso)</option>
            <option value="active_http">Web HTTP sin HTTPS</option>
            <option value="active_https">Web HTTPS activa</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="max-reviews-input"
            className="block text-xs font-semibold text-slate-700 mb-1.5"
          >
            Tope referencial de reseñas (0 = sin filtro)
          </label>
          <input
            id="max-reviews-input"
            type="number"
            min="0"
            placeholder="0 (sin límite)"
            className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-purple-600 focus:border-purple-600 outline-none transition-colors font-mono-tabular"
            value={params.maxReviews || ''}
            onChange={(e) =>
              setParams({ ...params, maxReviews: Math.max(0, parseInt(e.target.value, 10) || 0) })
            }
            disabled={isLoading}
          />
        </div>
      </div>

      {params.subzone && (
        <div className="mt-3 flex items-center gap-2 text-xs text-purple-800 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">
          <MapPin className="w-3.5 h-3.5 shrink-0" />
          <span>
            Subzona activa: <strong>{params.subzone}</strong>
          </span>
          <button
            type="button"
            onClick={() => setParams((p) => ({ ...p, subzone: '' }))}
            className="ml-auto text-purple-700 hover:underline font-medium"
          >
            Quitar subzona
          </button>
        </div>
      )}

      <div className="mt-4 flex flex-col sm:flex-row gap-3">
        <button
          type="submit"
          disabled={isLoading || !params.businessType.trim() || !params.location.trim()}
          className="flex-1 bg-purple-700 hover:bg-purple-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 px-5 rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
        >
          <Search className="w-4 h-4" />
          {isLoading ? 'Consultando Places API (New)...' : 'Buscar Oportunidades Reales'}
        </button>

        <button
          type="button"
          disabled={
            isLoadingSubzones ||
            isLoading ||
            !params.businessType.trim() ||
            !params.location.trim()
          }
          onClick={() => onSuggestSubzones(params.location.trim(), params.businessType.trim())}
          className="bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed text-slate-700 border border-slate-300 font-medium py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap text-sm"
        >
          <Sparkles className="w-4 h-4 text-purple-700" />
          {isLoadingSubzones ? 'Consultando subzonas...' : 'Sugerir subzonas (Gemini)'}
        </button>
      </div>

      {subzoneError && (
        <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {subzoneError}
        </div>
      )}

      {subzones.length > 0 && (
        <div className="mt-4 pt-3 border-t border-slate-100">
          <div className="text-xs font-medium text-slate-600 mb-2">
            Subzonas geográficas sugeridas ({subzoneRationale})
          </div>
          <div className="flex flex-wrap gap-2">
            {subzones.map((zone) => {
              const active = params.subzone === zone;
              return (
                <button
                  key={zone}
                  type="button"
                  onClick={() => handleSubzoneClick(zone)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-purple-700 text-white border-purple-700'
                      : 'bg-slate-50 text-slate-700 border-slate-200 hover:border-purple-400 hover:text-purple-800'
                  }`}
                >
                  {zone}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </form>
  );
};
