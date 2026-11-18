
import React, { useState } from 'react';
import { SearchParams } from '../types';

interface SearchFormProps {
  onSearch: (params: SearchParams) => void;
  isLoading: boolean;
}

export const SearchForm: React.FC<SearchFormProps> = ({ onSearch, isLoading }) => {
  const [params, setParams] = useState<SearchParams>({
    businessType: '',
    location: '',
    maxReviews: 0
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (params.businessType && params.location) {
      onSearch(params);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white p-6 rounded-xl shadow-lg border-t-4 border-purple-700">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">Tipo de Negocio</label>
          <input
            type="text"
            placeholder="Ej: Pollerías, Veterinarias..."
            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none transition-all"
            value={params.businessType}
            onChange={(e) => setParams({ ...params, businessType: e.target.value })}
            disabled={isLoading}
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">Ubicación (Perú)</label>
          <input
            type="text"
            placeholder="Ej: Los Olivos, Lima"
            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none transition-all"
            value={params.location}
            onChange={(e) => setParams({ ...params, location: e.target.value })}
            disabled={isLoading}
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">Máximo de Reseñas</label>
          <input
            type="number"
            min="0"
            placeholder="Sin límite (0)"
            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none transition-all"
            value={params.maxReviews || ''}
            onChange={(e) => setParams({ ...params, maxReviews: parseInt(e.target.value) || 0 })}
            disabled={isLoading}
          />
        </div>
      </div>
      <button
        type="submit"
        disabled={isLoading}
        className={`mt-6 w-full bg-purple-700 hover:bg-purple-800 text-white font-semibold py-4 px-6 rounded-lg transition-all transform hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-2 ${isLoading ? 'opacity-70 cursor-not-allowed' : ''}`}
      >
        {isLoading ? (
          <>
            <svg className="animate-spin h-5 w-5 text-white" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Iniciando Extracción Profunda...
          </>
        ) : (
          'Extraer Prospectos'
        )}
      </button>
    </form>
  );
};
