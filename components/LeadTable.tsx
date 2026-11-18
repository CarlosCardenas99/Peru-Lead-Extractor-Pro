
import React from 'react';
import { BusinessLead } from '../types';

interface LeadTableProps {
  leads: BusinessLead[];
}

export const LeadTable: React.FC<LeadTableProps> = ({ leads }) => {
  if (leads.length === 0) return null;

  return (
    <div className="overflow-x-auto bg-white rounded-xl shadow-lg border border-gray-200 mt-4">
      <table className="w-full text-left border-collapse">
        <thead className="bg-purple-700 text-white">
          <tr>
            <th className="p-4 font-semibold text-sm uppercase">Negocio</th>
            <th className="p-4 font-semibold text-sm uppercase">Calificación</th>
            <th className="p-4 font-semibold text-sm uppercase">Reseñas</th>
            <th className="p-4 font-semibold text-sm uppercase">Sitio Web</th>
            <th className="p-4 font-semibold text-sm uppercase">Teléfono</th>
            <th className="p-4 font-semibold text-sm uppercase">Enlace</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {leads.map((lead) => (
            <tr key={lead.id} className="hover:bg-purple-50 transition-colors">
              <td className="p-4 text-sm font-semibold text-gray-800">
                {lead.name}
                <div className="text-[10px] text-gray-400 font-normal truncate max-w-[200px]">{lead.address}</div>
              </td>
              <td className="p-4 text-sm">
                <span className="bg-yellow-100 text-yellow-800 px-2 py-1 rounded text-xs font-bold whitespace-nowrap">
                  ★ {lead.rating}
                </span>
              </td>
              <td className="p-4 text-sm text-gray-600">{lead.reviews}</td>
              <td className="p-4 text-sm">
                {lead.website && lead.website.toLowerCase() !== 'n/a' ? (
                  <a
                    href={lead.website.startsWith('http') ? lead.website : `https://${lead.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-600 hover:text-purple-900 font-medium truncate block max-w-[150px]"
                    title={lead.website}
                  >
                    Visitar Web
                  </a>
                ) : (
                  <span className="text-gray-300 italic text-xs">No disponible</span>
                )}
              </td>
              <td className="p-4 text-sm text-purple-700 font-semibold">{lead.phone}</td>
              <td className="p-4 text-sm">
                <a
                  href={lead.mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-600 hover:text-purple-900 underline font-medium text-xs flex items-center gap-1"
                >
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                  </svg>
                  Maps
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
