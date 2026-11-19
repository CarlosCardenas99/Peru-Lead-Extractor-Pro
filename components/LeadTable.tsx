import React from 'react';
import { ExternalLink, Globe, ShieldCheck, Slash } from 'lucide-react';
import { BusinessLead, WebsiteVerificationStatus } from '../types';
import { getPhoneStageLabel } from '../utils/peruPhone';

interface LeadTableProps {
  leads: BusinessLead[];
  selectedPlaceId: string | null;
  verifyingPlaceId: string | null;
  onSelectPlace: (lead: BusinessLead) => void;
  onVerifyWebsite: (lead: BusinessLead) => void;
  onDiscardPlace: (lead: BusinessLead) => void;
}

function getWebsiteStatusPresentation(status: WebsiteVerificationStatus): {
  label: string;
  toneClass: string;
} {
  switch (status) {
    case 'confirmed_none':
      return { label: 'Confirmado sin web', toneClass: 'text-emerald-800' };
    case 'unregistered':
      return { label: 'Sin web registrada', toneClass: 'text-amber-800' };
    case 'unreachable_verified':
      return { label: 'Caída verificada', toneClass: 'text-emerald-800' };
    case 'social_only':
      return { label: 'Solo red social', toneClass: 'text-amber-800' };
    case 'active_http':
      return { label: 'Web HTTP sin HTTPS', toneClass: 'text-amber-800' };
    case 'invalid_url':
      return { label: 'URL inválida', toneClass: 'text-amber-800' };
    case 'unverified_inconclusive':
      return { label: 'No verificado (Inconcluso)', toneClass: 'text-slate-600' };
    case 'active_https':
    default:
      return { label: 'Web HTTPS activa', toneClass: 'text-slate-600' };
  }
}

export const LeadTable: React.FC<LeadTableProps> = ({
  leads,
  selectedPlaceId,
  verifyingPlaceId,
  onSelectPlace,
  onVerifyWebsite,
  onDiscardPlace,
}) => {
  if (leads.length === 0) return null;

  return (
    <div className="overflow-x-auto bg-white rounded-xl border border-slate-200 shadow-sm">
      <table className="w-full text-left border-collapse">
        <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
          <tr>
            <th className="py-3 px-4 font-semibold text-xs">Negocio · Dirección (Google)</th>
            <th className="py-3 px-3 font-semibold text-xs">Estado Web e Independencia</th>
            <th className="py-3 px-3 font-semibold text-xs">Teléfono y Verificación</th>
            <th className="py-3 px-3 font-semibold text-xs text-right">Oport. Digital</th>
            <th className="py-3 px-3 font-semibold text-xs text-right">Calidad Contacto</th>
            <th className="py-3 px-3 font-semibold text-xs text-right">Confianza Info</th>
            <th className="py-3 px-3 font-semibold text-xs text-right">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {leads.map((lead) => {
            const isSelected = lead.placeId === selectedPlaceId;
            const webMeta = getWebsiteStatusPresentation(lead.websiteProbe.status);
            const activePhone = lead.independentPhone || lead.phone;
            const activePhoneStage =
              lead.phoneAnalysis.stage === 'independently_corroborated' ||
              lead.phoneAnalysis.stage === 'contact_reached'
                ? lead.phoneAnalysis.stage
                : lead.phoneAnalysis.stage;
            const isClosedTemp = lead.businessStatus === 'CLOSED_TEMPORARILY';
            const isClosedPerm = lead.businessStatus === 'CLOSED_PERMANENTLY';

            return (
              <tr
                key={lead.placeId}
                onClick={() => onSelectPlace(lead)}
                className={`cursor-pointer transition-colors ${
                  isSelected ? 'bg-purple-50/80' : 'hover:bg-slate-50'
                }`}
              >
                <td className="py-3 px-4 align-top max-w-[260px]">
                  <div className="text-sm font-semibold text-slate-900 leading-snug">
                    {lead.name}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 truncate" title={lead.address}>
                    {lead.address}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 font-mono-tabular">
                    <span>★ {lead.rating}</span>
                    <span aria-hidden="true">·</span>
                    <span>{lead.reviews} reseñas</span>
                    {isClosedPerm && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-rose-700 font-semibold">Cerrado perm.</span>
                      </>
                    )}
                    {isClosedTemp && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-amber-700 font-semibold">Cerrado temp.</span>
                      </>
                    )}
                    {lead.exclusionMatch.excluded && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-rose-700 font-semibold">En exclusión</span>
                      </>
                    )}
                  </div>
                </td>

                <td className="py-3 px-3 align-top">
                  <div className={`text-xs font-semibold ${webMeta.toneClass}`}>
                    {webMeta.label}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5 max-w-[200px] truncate" title={lead.websiteProbe.summary}>
                    {lead.websiteProbe.provenance === 'manual_user'
                      ? 'Manual WEBNEX'
                      : lead.websiteProbe.provenance === 'independent_http'
                      ? 'Verificación HTTP'
                      : 'Google Places'}{' '}
                    · {lead.websiteProbe.summary}
                  </div>
                  {lead.website && (
                    <a
                      href={lead.website.startsWith('http') ? lead.website : `https://${lead.website}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 text-[11px] text-purple-700 hover:underline mt-1 truncate max-w-[190px]"
                    >
                      <Globe className="w-3 h-3 shrink-0" />
                      {lead.website.replace(/^https?:\/\//i, '')}
                    </a>
                  )}
                </td>

                <td className="py-3 px-3 align-top">
                  <div className="text-xs font-medium text-slate-800 font-mono-tabular">
                    {activePhone}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {getPhoneStageLabel(activePhoneStage)}
                  </div>
                </td>

                <td className="py-3 px-3 align-top text-right">
                  <div className="text-sm font-semibold text-purple-800 font-mono-tabular">
                    {lead.digitalScore.score}/100
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {lead.digitalScore.isIndependentlyVerified ? 'Verificado' : 'Por confirmar'}
                  </div>
                </td>

                <td className="py-3 px-3 align-top text-right">
                  <div className="text-sm font-semibold text-slate-800 font-mono-tabular">
                    {lead.contactabilityScore.score}/100
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {lead.contactabilityScore.isIndependentlyCorroborated
                      ? 'Corroborado'
                      : 'Ref. Google'}
                  </div>
                </td>

                <td className="py-3 px-3 align-top text-right">
                  <div
                    className={`text-sm font-semibold font-mono-tabular ${
                      lead.trustScore.hasContradictions
                        ? 'text-rose-700'
                        : lead.trustScore.score >= 75
                        ? 'text-emerald-700'
                        : 'text-slate-700'
                    }`}
                  >
                    {lead.trustScore.score}/100
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {lead.trustScore.hasContradictions
                      ? 'Con alertas'
                      : lead.trustScore.score >= 75
                      ? 'Alta'
                      : lead.trustScore.score >= 45
                      ? 'Media'
                      : 'Por corroborar'}
                  </div>
                </td>

                <td
                  className="py-3 px-3 align-top text-right whitespace-nowrap"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="inline-flex items-center gap-1.5">
                    {lead.website && (
                      <button
                        type="button"
                        disabled={verifyingPlaceId === lead.placeId}
                        onClick={() => onVerifyWebsite(lead)}
                        className="px-2.5 py-1.5 text-xs font-medium border border-slate-300 rounded-md text-slate-700 hover:bg-slate-100 disabled:opacity-50 inline-flex items-center gap-1"
                        title="Ejecutar verificación HTTP independiente"
                      >
                        <ShieldCheck className="w-3.5 h-3.5 text-purple-700" />
                        {verifyingPlaceId === lead.placeId ? 'Verificando...' : 'Verificar Web'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onSelectPlace(lead)}
                      className="px-2.5 py-1.5 text-xs font-medium bg-purple-700 text-white rounded-md hover:bg-purple-800"
                    >
                      Revisar
                    </button>
                    <a
                      href={lead.mapsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 text-slate-500 hover:text-purple-700 border border-slate-200 rounded-md"
                      title="Abrir en Google Maps"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                    <button
                      type="button"
                      onClick={() => onDiscardPlace(lead)}
                      className="p-1.5 text-slate-500 hover:text-rose-700 border border-slate-200 rounded-md"
                      title="Descartar establecimiento"
                    >
                      <Slash className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
