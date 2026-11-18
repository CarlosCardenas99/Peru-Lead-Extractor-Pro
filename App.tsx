
import React, { useState, useMemo } from 'react';
import { SearchForm } from './components/SearchForm';
import { LeadTable } from './components/LeadTable';
import { ExportButton } from './components/ExportButton';
import { Pagination } from './components/Pagination';
import { extractLeads } from './services/geminiService';
import { BusinessLead, SearchParams, ScrapingState } from './types';

const App: React.FC = () => {
  const [state, setState] = useState<ScrapingState>({
    isLoading: false,
    error: null,
    leads: [],
    currentPage: 1,
    itemsPerPage: 50
  });

  const [searchProgress, setSearchProgress] = useState<string>("");
  const [currentParams, setCurrentParams] = useState<SearchParams | null>(null);

  const handleSearch = async (params: SearchParams) => {
    setState(prev => ({ ...prev, isLoading: true, error: null, leads: [], currentPage: 1 }));
    setCurrentParams(params);
    
    let allFound: BusinessLead[] = [];
    let attempts = 0;
    const MAX_ATTEMPTS = 5;
    const MINIMUM_LEADS_GOAL = 20;

    try {
      while (allFound.length < MINIMUM_LEADS_GOAL && attempts < MAX_ATTEMPTS) {
        attempts++;
        setSearchProgress(`Escaneando... Intento ${attempts}. Prospectos únicos: ${allFound.length}/${MINIMUM_LEADS_GOAL}`);
        
        const batch = await extractLeads(params, attempts);
        
        const newLeads = batch.filter(nb => 
          !allFound.some(existing => existing.name.toLowerCase().trim() === nb.name.toLowerCase().trim())
        );

        if (newLeads.length > 0) {
          allFound = [...allFound, ...newLeads];
          setState(prev => ({ ...prev, leads: [...allFound] }));
        } else if (attempts > 2 && allFound.length > 0) {
          // Si ya tenemos leads y no encontramos nuevos en el 3er intento, paramos
          break;
        }
        
        await new Promise(r => setTimeout(r, 600));
      }

      if (allFound.length === 0) {
        throw new Error("No se pudo extraer ningún negocio con esos criterios. Prueba con una ubicación más amplia o un rubro menos específico.");
      }

      setState(prev => ({
        ...prev,
        isLoading: false,
        leads: allFound
      }));
      setSearchProgress("");
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: err.message || "Error inesperado durante la extracción."
      }));
      setSearchProgress("");
    }
  };

  const handleLoadMore = async () => {
    if (!currentParams) return;
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    setSearchProgress("Buscando más prospectos...");
    
    try {
      const moreData = await extractLeads(currentParams, Math.floor(state.leads.length / 10) + 1);
      const uniqueMore = moreData.filter(m => 
        !state.leads.some(p => p.name.toLowerCase().trim() === m.name.toLowerCase().trim())
      );

      setState(prev => ({
        ...prev,
        isLoading: false,
        leads: [...prev.leads, ...uniqueMore]
      }));
      setSearchProgress("");
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: "No se pudieron obtener más resultados."
      }));
      setSearchProgress("");
    }
  };

  const currentTableLeads = useMemo(() => {
    const start = (state.currentPage - 1) * state.itemsPerPage;
    return state.leads.slice(start, start + state.itemsPerPage);
  }, [state.leads, state.currentPage, state.itemsPerPage]);

  return (
    <div className="min-h-screen pb-32 bg-slate-50">
      <header className="bg-purple-700 text-white py-8 shadow-md">
        <div className="container mx-auto px-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold flex items-center gap-3">
                <svg className="w-10 h-10" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                </svg>
                Peru Lead Extractor Pro
              </h1>
              <p className="mt-1 opacity-90">Extracción comercial inteligente para el mercado peruano.</p>
            </div>
            {state.leads.length > 0 && <ExportButton leads={state.leads} />}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 mt-8">
        <div className="max-w-6xl mx-auto">
          <SearchForm onSearch={handleSearch} isLoading={state.isLoading} />

          {state.isLoading && (
            <div className="mt-6 flex flex-col items-center justify-center p-10 bg-white rounded-xl shadow-sm border-2 border-purple-100">
              <div className="relative mb-4">
                <div className="w-16 h-16 border-4 border-purple-100 border-t-purple-700 rounded-full animate-spin"></div>
                <div className="absolute inset-0 flex items-center justify-center">
                   <span className="text-purple-700 font-bold">{state.leads.length}</span>
                </div>
              </div>
              <p className="text-purple-700 font-semibold text-xl text-center">{searchProgress}</p>
            </div>
          )}

          {state.error && !state.isLoading && (
            <div className="mt-6 bg-red-50 border-l-4 border-red-500 text-red-800 p-5 rounded shadow-sm">
              <div className="flex items-center gap-3">
                <svg className="w-6 h-6 text-red-500" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <span className="font-bold">Aviso:</span>
              </div>
              <p className="mt-1 ml-9">{state.error}</p>
            </div>
          )}

          {!state.isLoading && state.leads.length === 0 && !state.error && (
            <div className="mt-12 text-center text-gray-500">
              <div className="bg-white p-16 rounded-[2.5rem] shadow-sm border border-dashed border-gray-300">
                <p className="text-2xl font-bold text-gray-800 mb-2">Listo para extraer leads</p>
                <p className="text-gray-500 max-w-md mx-auto">Nuestro motor localizará al menos 20 prospectos únicos en la zona seleccionada.</p>
              </div>
            </div>
          )}

          {state.leads.length > 0 && (
            <div className="mt-8">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 px-2 mb-4">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-2xl font-bold text-gray-900">Resultados Encontrados</h2>
                  <span className="bg-purple-700 text-white px-3 py-1 rounded-full text-xs font-bold">
                    {state.leads.length} LEADS
                  </span>
                </div>
                {!state.isLoading && (
                  <button
                    onClick={handleLoadMore}
                    className="bg-purple-100 text-purple-700 hover:bg-purple-200 font-bold py-2 px-6 rounded-lg text-sm transition-all border border-purple-200 shadow-sm flex items-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                    </svg>
                    Escanear Más
                  </button>
                )}
              </div>
              
              <LeadTable leads={currentTableLeads} />
              
              <Pagination
                currentPage={state.currentPage}
                totalItems={state.leads.length}
                itemsPerPage={state.itemsPerPage}
                onPageChange={(page) => {
                  setState(s => ({ ...s, currentPage: page }));
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              />
            </div>
          )}
        </div>
      </main>

      {state.leads.length > 0 && (
        <footer className="fixed bottom-0 left-0 right-0 bg-white/80 backdrop-blur-md border-t border-gray-200 p-4 shadow-2xl flex justify-center gap-10 md:gap-24 z-50">
          <div className="text-center">
            <p className="text-[10px] text-gray-400 uppercase font-black tracking-widest">Base de Datos</p>
            <p className="text-xl font-bold text-purple-700">{state.leads.length} Leads</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-gray-400 uppercase font-black tracking-widest">Página</p>
            <p className="text-xl font-bold text-gray-800">{state.currentPage} / {Math.ceil(state.leads.length / state.itemsPerPage)}</p>
          </div>
          <div className="text-center hidden md:block">
            <p className="text-[10px] text-gray-400 uppercase font-black tracking-widest">Región</p>
            <p className="text-xl font-bold text-gray-800">PERÚ 🇵🇪</p>
          </div>
        </footer>
      )}
    </div>
  );
};

export default App;
