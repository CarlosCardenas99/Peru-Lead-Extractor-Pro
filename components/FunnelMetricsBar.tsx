import React from 'react';
import { IndependentFunnelMetrics } from '../types';

interface FunnelMetricsBarProps {
  metrics: IndependentFunnelMetrics;
}

export const FunnelMetricsBar: React.FC<FunnelMetricsBarProps> = ({ metrics }) => {
  const items: Array<{ label: string; value: number | string; sub: string }> = [
    {
      label: 'Negocios analizados',
      value: metrics.uniqueBusinessesFound,
      sub: 'Únicos por Place ID',
    },
    {
      label: 'Descartados por fijo',
      value: metrics.discardedLandlineCount,
      sub: 'Solo teléfono fijo',
    },
    {
      label: 'Sin móvil registrado',
      value: metrics.noMobileCount,
      sub: 'Requiere captura manual',
    },
    {
      label: 'Oportunidades digitales',
      value: metrics.verifiableDigitalOpportunities,
      sub: 'Brecha web comprobable',
    },
    {
      label: 'Pend. corroboración',
      value: metrics.pendingCorroborationCount,
      sub: 'Por verificar manualmente',
    },
    {
      label: 'Preseleccionados',
      value: metrics.preselectedCount,
      sub: 'En etapa PRESELECCIONADO',
    },
    {
      label: 'Duplicados / excluidos',
      value: metrics.duplicatesAndExcludedCount,
      sub: 'Lista exclusión y descartes',
    },
    {
      label: 'Contactos autorizados',
      value: metrics.authorizedContactsCount,
      sub: 'Con base legal registrada',
    },
    {
      label: 'Respuestas / ventas',
      value: `${metrics.responsesReceived} / ${metrics.confirmedSales}`,
      sub: 'Respuestas y clientes reales',
    },
  ];

  return (
    <section
      aria-label="Métricas independientes del cualificador y embudo comercial"
      className="bg-white border border-slate-200 rounded-xl p-4"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3 pb-2 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-800">
          Métricas del Cualificador y Embudo Comercial WEBNEX
        </h2>
        <span className="text-xs text-slate-500">
          Conteos reales sin tasas estimadas ni automatización de mensajería
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-9 gap-2.5">
        {items.map((item) => (
          <div
            key={item.label}
            className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 flex flex-col justify-between"
          >
            <div className="text-[11px] font-medium text-slate-600 leading-snug">
              {item.label}
            </div>
            <div className="mt-1.5">
              <div className="text-lg font-semibold text-slate-900 font-mono-tabular">
                {item.value}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5 truncate" title={item.sub}>
                {item.sub}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
