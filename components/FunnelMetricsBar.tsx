import React from 'react';
import { IndependentFunnelMetrics } from '../types';

interface FunnelMetricsBarProps {
  metrics: IndependentFunnelMetrics;
}

export const FunnelMetricsBar: React.FC<FunnelMetricsBarProps> = ({ metrics }) => {
  const items: Array<{ label: string; value: number; sub: string }> = [
    {
      label: 'Negocios únicos encontrados',
      value: metrics.uniqueBusinessesFound,
      sub: 'Por Place ID en sesión',
    },
    {
      label: 'Datos corroborados',
      value: metrics.corroboratedRecords,
      sub: 'Verificación independiente',
    },
    {
      label: 'Oportunidad digital comprobable',
      value: metrics.verifiableDigitalOpportunities,
      sub: 'Brecha web confirmada',
    },
    {
      label: 'Contactos autorizados',
      value: metrics.authorizedContactsMade,
      sub: 'Gestión manual directa',
    },
    {
      label: 'Respuestas obtenidas',
      value: metrics.responsesReceived,
      sub: 'Interacción real',
    },
    {
      label: 'Oportunidades calificadas',
      value: metrics.qualifiedOpportunities,
      sub: 'Interesado o Cotización',
    },
    {
      label: 'Ventas confirmadas',
      value: metrics.confirmedSales,
      sub: 'Clientes cerrados',
    },
  ];

  return (
    <section
      aria-label="Métricas independientes del embudo comercial"
      className="bg-white border border-slate-200 rounded-xl p-4"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3 pb-2 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-800">
          Métricas Independientes WEBNEX
        </h2>
        <span className="text-xs text-slate-500">
          Conteos reales sin tasas de conversión estimadas ni mensajería masiva
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {items.map((item) => (
          <div
            key={item.label}
            className="p-3 rounded-lg bg-slate-50 border border-slate-200/80 flex flex-col justify-between"
          >
            <div className="text-xs font-medium text-slate-600 leading-snug">
              {item.label}
            </div>
            <div className="mt-2">
              <div className="text-2xl font-semibold text-slate-900 font-mono-tabular">
                {item.value}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5 truncate" title={item.sub}>
                {item.sub}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
