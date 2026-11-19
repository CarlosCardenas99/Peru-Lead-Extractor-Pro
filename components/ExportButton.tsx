import React from 'react';
import { Download } from 'lucide-react';
import { FollowupLeadRecord } from '../types';
import { formatPhoneLineTypeLabel } from '../utils/followupHydration';
import {
  evaluateFollowupCompleteness,
  formatIndependentSourceLabel,
  getCommercialOutcomeLabel,
  parseVerificationProvenanceEntry,
  resolveIndependentPhoneType,
} from '../utils/fieldCompliance';

interface ExportButtonProps {
  followups: FollowupLeadRecord[];
}

function escapeCsvCell(value: string | number | boolean): string {
  const str = String(value ?? '');
  // Prevent CSV spreadsheet formula injection
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Exporta EXCLUSIVAMENTE registros del módulo de seguimiento CRM que contienen
 * datos obtenidos independientemente o ingresados manualmente por el equipo WEBNEX.
 * Nunca exporta contenido ni referencias hidratadas de Google Maps.
 */
export const ExportButton: React.FC<ExportButtonProps> = ({ followups }) => {
  const exportableRecords = followups.filter(
    (item) => item.independentBusinessName.trim().length > 0
  );

  const downloadCSV = () => {
    if (exportableRecords.length === 0) return;

    const headers = [
      'Nombre Comercial Independiente',
      'Categoría Propia',
      'Dirección Independiente',
      'Distrito / Zona',
      'Sitio Web Independiente',
      'Estado Seguimiento',
      'Estado Ficha',
      'Base Legal / Evidencia Consentimiento',
      'Confirmado Sin Web',
      'Estado Web Independiente',
      'Teléfono Independiente',
      'Tipo Teléfono',
      'Estado Verificación Teléfono',
      'Correo Independiente',
      'Puntaje Oportunidad Digital',
      'Puntaje Contactabilidad',
      'Puntaje Confianza Info',
      'Resultado Comercial Real',
      'Fuentes de Verificación',
      'Última Verificación',
      'Notas',
      'Actualizado',
    ];

    const rows = exportableRecords.map((item) => {
      const phoneType = resolveIndependentPhoneType(
        item.independentPhone,
        item.independentPhoneType
      );
      const completeness = evaluateFollowupCompleteness(item);
      const provenanceText = (item.verificationSources || [])
        .map((raw) => {
          const p = parseVerificationProvenanceEntry(raw);
          return `${p.field}: ${formatIndependentSourceLabel(p.source)}`;
        })
        .join(' | ');

      return [
        escapeCsvCell(item.independentBusinessName),
        escapeCsvCell(item.independentCategory || ''),
        escapeCsvCell(item.independentAddress || ''),
        escapeCsvCell(item.district),
        escapeCsvCell(item.independentWebsite || ''),
        escapeCsvCell(item.stage),
        escapeCsvCell(completeness.label),
        escapeCsvCell(item.legalBasis),
        escapeCsvCell(item.confirmedNoWebsite ? 'Sí' : 'No'),
        escapeCsvCell(item.independentWebsiteStatus),
        escapeCsvCell(item.independentPhone),
        escapeCsvCell(item.independentPhone.trim() ? formatPhoneLineTypeLabel(phoneType) : ''),
        escapeCsvCell(item.phoneStage),
        escapeCsvCell(item.independentEmail),
        escapeCsvCell(item.independentDigitalScore),
        escapeCsvCell(item.independentContactScore),
        escapeCsvCell(typeof item.independentTrustScore === 'number' ? item.independentTrustScore : ''),
        escapeCsvCell(getCommercialOutcomeLabel(item.commercialOutcome)),
        escapeCsvCell(provenanceText),
        escapeCsvCell(item.lastVerifiedAt || ''),
        escapeCsvCell(item.notes),
        escapeCsvCell(item.updatedAt),
      ].join(',');
    });

    const csvContent = '\uFEFF' + [headers.map(escapeCsvCell).join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `webnex_seguimiento_independiente_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <button
      type="button"
      disabled={exportableRecords.length === 0}
      onClick={downloadCSV}
      className="bg-purple-700 hover:bg-purple-800 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded-lg text-xs inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
      title={
        exportableRecords.length === 0
          ? 'Solo exportable cuando los registros cuentan con datos ingresados independientemente'
          : 'Exporta únicamente registros con datos independientes (sin datos de Google Maps)'
      }
    >
      <Download className="w-4 h-4" />
      Exportar CRM Indep. ({exportableRecords.length})
    </button>
  );
};
