
import React from 'react';
import { BusinessLead } from '../types';

interface ExportButtonProps {
  leads: BusinessLead[];
}

export const ExportButton: React.FC<ExportButtonProps> = ({ leads }) => {
  const downloadCSV = () => {
    const headers = ["Nombre de Negocio", "Calificación", "Reseñas", "Sitio Web", "Dirección Completa", "Número de Teléfono", "URL Google Maps"];
    const rows = leads.map(l => [
      `"${l.name.replace(/"/g, '""')}"`,
      l.rating,
      l.reviews,
      `"${l.website}"`,
      `"${l.address.replace(/"/g, '""')}"`,
      `"${l.phone}"`,
      l.mapsUrl
    ]);

    const csvContent = "data:text/csv;charset=utf-8," 
      + headers.join(",") + "\n"
      + rows.map(e => e.join(",")).join("\n");

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `leads_peru_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <button
      onClick={downloadCSV}
      className="bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-lg flex items-center gap-2 transition-all shadow-md"
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
      </svg>
      Descargar CSV
    </button>
  );
};
