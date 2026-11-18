import React from 'react';

interface PaginationProps {
  currentPage: number;
  totalItems: number;
  itemsPerPage: number;
  onPageChange: (page: number) => void;
}

export const Pagination: React.FC<PaginationProps> = ({
  currentPage,
  totalItems,
  itemsPerPage,
  onPageChange,
}) => {
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between bg-white px-4 py-3 rounded-xl border border-slate-200 mt-4">
      <div className="flex flex-1 justify-between sm:hidden">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage === 1}
          className="px-4 py-2 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Anterior
        </button>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage === totalPages}
          className="px-4 py-2 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Siguiente
        </button>
      </div>
      <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
        <p className="text-xs text-slate-600 font-mono-tabular">
          Mostrando {(currentPage - 1) * itemsPerPage + 1} a{' '}
          {Math.min(currentPage * itemsPerPage, totalItems)} de {totalItems} resultados locales
        </p>
        <nav className="inline-flex -space-x-px rounded-lg shadow-xs" aria-label="Paginación">
          <button
            type="button"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage === 1}
            className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-l-lg hover:bg-slate-50 disabled:opacity-50"
          >
            Anterior
          </button>
          {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
            let pageNum = currentPage;
            if (currentPage < 3) pageNum = i + 1;
            else if (currentPage > totalPages - 2) pageNum = totalPages - 4 + i;
            else pageNum = currentPage - 2 + i;
            if (pageNum < 1 || pageNum > totalPages) return null;
            return (
              <button
                key={pageNum}
                type="button"
                onClick={() => onPageChange(pageNum)}
                className={`px-3 py-1.5 text-xs font-semibold border border-slate-300 font-mono-tabular ${
                  currentPage === pageNum
                    ? 'bg-purple-700 text-white border-purple-700 z-10'
                    : 'bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {pageNum}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage === totalPages}
            className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-r-lg hover:bg-slate-50 disabled:opacity-50"
          >
            Siguiente
          </button>
        </nav>
      </div>
    </div>
  );
};
