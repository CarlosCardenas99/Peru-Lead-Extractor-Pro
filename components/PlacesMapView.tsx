import React, { useEffect, useState } from 'react';
import {
  APIProvider,
  APILoadingStatus,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  Pin,
  useApiLoadingStatus,
  useMap,
} from '@vis.gl/react-google-maps';
import { MapPin } from 'lucide-react';
import { BusinessLead } from '../types';

interface PlacesMapViewProps {
  leads: BusinessLead[];
  selectedPlaceId: string | null;
  onSelectPlace: (lead: BusinessLead) => void;
}

const DEFAULT_LIMA_CENTER = { lat: -12.0464, lng: -77.0428 };

function getPinPalette(lead: BusinessLead): {
  background: string;
  borderColor: string;
  glyphColor: string;
} {
  if (lead.confirmedNoWebsite || lead.websiteProbe.status === 'confirmed_none') {
    return { background: '#15803d', borderColor: '#14532d', glyphColor: '#ffffff' };
  }
  if (
    lead.websiteProbe.status === 'unregistered' ||
    lead.websiteProbe.status === 'unreachable_verified' ||
    lead.websiteProbe.status === 'social_only'
  ) {
    return { background: '#7e22ce', borderColor: '#581c87', glyphColor: '#ffffff' };
  }
  if (lead.websiteProbe.status === 'unverified_inconclusive') {
    return { background: '#b45309', borderColor: '#78350f', glyphColor: '#ffffff' };
  }
  return { background: '#475569', borderColor: '#1e293b', glyphColor: '#ffffff' };
}

const MapController: React.FC<{
  leads: BusinessLead[];
  selectedPlaceId: string | null;
  onSelectPlace: (lead: BusinessLead) => void;
}> = ({ leads, selectedPlaceId, onSelectPlace }) => {
  const map = useMap();
  const status = useApiLoadingStatus();
  const [infoLead, setInfoLead] = useState<BusinessLead | null>(null);

  useEffect(() => {
    if (!map || !selectedPlaceId) return;
    const target = leads.find((l) => l.placeId === selectedPlaceId);
    if (target?.location) {
      map.panTo(target.location);
      if ((map.getZoom() || 12) < 15) {
        map.setZoom(15);
      }
      setInfoLead(target);
    }
  }, [map, selectedPlaceId, leads]);

  useEffect(() => {
    if (!map || leads.length === 0) return;
    const withCoords = leads.filter((l) => l.location !== null);
    if (withCoords.length === 0) return;

    if (withCoords.length === 1 && withCoords[0].location) {
      map.setCenter(withCoords[0].location);
      map.setZoom(15);
      return;
    }

    if (typeof google !== 'undefined' && google.maps?.LatLngBounds) {
      const bounds = new google.maps.LatLngBounds();
      for (const l of withCoords) {
        if (l.location) bounds.extend(l.location);
      }
      map.fitBounds(bounds, 48);
    }
  }, [map, leads]);

  if (status === APILoadingStatus.FAILED || status === APILoadingStatus.AUTH_FAILURE) {
    return (
      <div className="absolute inset-0 bg-slate-100/95 flex flex-col items-center justify-center p-6 text-center z-10">
        <p className="text-sm font-semibold text-slate-800">
          No se pudo cargar el mapa interactivo de Google Maps
        </p>
        <p className="text-xs text-slate-600 mt-1 max-w-sm">
          Verifica que Google Maps JavaScript API esté habilitada para tu clave o que la cuota diaria no haya sido superada.
        </p>
      </div>
    );
  }

  return (
    <>
      {leads.map((lead) => {
        if (!lead.location) return null;
        const palette = getPinPalette(lead);
        const isSelected = lead.placeId === selectedPlaceId;
        return (
          <AdvancedMarker
            key={lead.placeId}
            position={lead.location}
            title={lead.name}
            zIndex={isSelected ? 50 : 1}
            onClick={() => {
              onSelectPlace(lead);
              setInfoLead(lead);
            }}
          >
            <Pin
              background={palette.background}
              borderColor={palette.borderColor}
              glyphColor={palette.glyphColor}
              scale={isSelected ? 1.25 : 1}
            />
          </AdvancedMarker>
        );
      })}

      {infoLead && infoLead.location && (
        <InfoWindow
          position={infoLead.location}
          maxWidth={260}
          onCloseClick={() => setInfoLead(null)}
        >
          <div className="p-1 text-slate-900">
            <div className="text-xs font-semibold">{infoLead.name}</div>
            <div className="text-[11px] text-slate-600 mt-0.5">{infoLead.address}</div>
            <div className="mt-1.5 flex items-center gap-2 text-[11px] font-mono-tabular">
              <span className="font-semibold text-purple-800">
                Oportunidad: {infoLead.digitalScore.score}/100
              </span>
              <span>·</span>
              <span>Contacto: {infoLead.contactabilityScore.score}/100</span>
            </div>
          </div>
        </InfoWindow>
      )}
    </>
  );
};

export const PlacesMapView: React.FC<PlacesMapViewProps> = ({
  leads,
  selectedPlaceId,
  onSelectPlace,
}) => {
  const envApiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();
  const [apiKey, setApiKey] = useState<string>(envApiKey);
  const [isCheckingKey, setIsCheckingKey] = useState<boolean>(!envApiKey);

  useEffect(() => {
    if (envApiKey) {
      setApiKey(envApiKey);
      setIsCheckingKey(false);
      return;
    }
    let cancelled = false;
    fetch('/api/maps-config')
      .then((r) => (r.ok ? r.json() : { mapsApiKey: '' }))
      .then((data) => {
        if (!cancelled) {
          setApiKey(String(data?.mapsApiKey || '').trim());
          setIsCheckingKey(false);
        }
      })
      .catch(() => {
        if (!cancelled) setIsCheckingKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, [envApiKey]);

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-purple-700" />
          <h3 className="text-sm font-semibold text-slate-900">
            Mapa Interactivo de Resultados
          </h3>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-600">
          <span>Verde: Confirmado sin web</span>
          <span>·</span>
          <span>Morado: Oportunidad web</span>
          <span>·</span>
          <span>Ámbar: No verificado</span>
        </div>
      </div>

      <div className="relative h-[480px] w-full bg-slate-100">
        {isCheckingKey ? (
          <div className="h-full w-full flex items-center justify-center p-6 text-xs text-slate-500">
            Inicializando mapa interactivo de Google Maps...
          </div>
        ) : !apiKey ? (
          <div className="h-full w-full flex flex-col items-center justify-center p-6 text-center">
            <MapPin className="w-8 h-8 text-slate-400 mb-2" />
            <p className="text-sm font-semibold text-slate-800">
              Mapa pendiente de habilitación de Google Maps Platform
            </p>
            <p className="text-xs text-slate-600 mt-1 max-w-md">
              Activa Google Maps Platform en el panel de configuración de Google AI Studio (Settings &gt; Google Maps) para visualizar marcadores avanzados y coordenadas reales.
            </p>
          </div>
        ) : (
          <APIProvider apiKey={apiKey} language="es" region="PE">
            <GoogleMap
              mapId="DEMO_MAP_ID"
              defaultCenter={DEFAULT_LIMA_CENTER}
              defaultZoom={12}
              gestureHandling="greedy"
              internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
              style={{ width: '100%', height: '100%' }}
            >
              <MapController
                leads={leads}
                selectedPlaceId={selectedPlaceId}
                onSelectPlace={onSelectPlace}
              />
            </GoogleMap>
          </APIProvider>
        )}
      </div>
    </div>
  );
};
