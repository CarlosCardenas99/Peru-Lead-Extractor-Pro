import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import { ChevronRight, LogIn, LogOut, ShieldCheck } from 'lucide-react';
import { SearchForm } from './components/SearchForm';
import { LeadTable } from './components/LeadTable';
import { Pagination } from './components/Pagination';
import { FunnelMetricsBar } from './components/FunnelMetricsBar';
import { PlacesMapView } from './components/PlacesMapView';
import { PlaceReviewDrawer, DrawerPromoteIndependentData } from './components/PlaceReviewDrawer';
import { FollowupCrmView } from './components/FollowupCrmView';
import { ExclusionManagerView } from './components/ExclusionManagerView';
import { SmartFilterBar } from './components/SmartFilterBar';
import {
  PreparedTransferItem,
  QualificationPreviewModal,
} from './components/QualificationPreviewModal';
import {
  buildBusinessLeadFromPlace,
  fetchPlaceDetailsBatch,
  fetchQuotaStatus,
  fetchSubzoneSuggestions,
  searchPlacesPage,
  verifyWebsiteUrl,
} from './services/geminiService';
import {
  batchImportExclusions,
  createBatchPreselectedFollowups,
  createFollowupRecord,
  CreateFollowupOutcome,
  deleteFollowupsBatchWithProgress,
  deleteTemporaryWorkItemsBatch,
  fetchActiveTemporaryWorkQueue,
  fetchFollowupsIntegritySnapshot,
  formatFriendlyFirestoreError,
  recoverMissingFollowupFieldsBatch,
  removeDiscardPlace,
  removeExclusionEntry,
  saveDiscardPlace,
  signInWithGooglePopup,
  signOutFirebase,
  subscribeToAuth,
  subscribeUserDiscards,
  subscribeUserExclusions,
  subscribeUserFollowups,
  testFirestoreConnection,
  updateFollowupRecord,
  UpdateFollowupOutcome,
  upsertTemporaryWorkItemsBatch,
  verifyUserFirestoreReadWrite,
} from './services/firebaseService';
import {
  BusinessLead,
  CrmWorkspaceMode,
  DEFAULT_SMART_FILTERS,
  DiscardRecord,
  ExclusionRecord,
  FollowupLeadRecord,
  GooglePlaceRaw,
  LeadQualificationResult,
  PhoneVerificationStage,
  PlaceHydrationEntry,
  PlacesQuotaBlockState,
  QualifierBatchSummary,
  QuotaStatus,
  SearchParams,
  SmartFilterState,
  TemporaryQueueEntry,
  TemporaryQueueIndependentDraft,
  TemporaryQueueOutcome,
  TemporaryQueuePriority,
  TemporaryQueueTtlHours,
  WebsiteFilterOption,
} from './types';
import {
  mergeHydrationBatchResults,
  selectNextHydrationBatch,
  SESSION_CACHE_TTL_MS,
} from './utils/followupHydration';
import {
  encodeVerificationProvenanceEntry,
  evaluateFollowupCompleteness,
  resolveIndependentPhoneType,
  resolveIndependentWebsiteStatusForSave,
} from './utils/fieldCompliance';
import { analyzePeruvianPhone } from './utils/peruPhone';
import {
  buildExclusionKeySet,
  checkPlaceAgainstExclusions,
} from './utils/exclusionUtils';
import {
  buildCrmAndDuplicateSets,
  matchesSmartFilters,
  qualifyLoadedLeadsBatch,
} from './utils/leadQualifier';
import {
  computeContactabilityScore,
  computeDigitalOpportunityScore,
  computeIndependentFunnelMetrics,
  computeInformationTrustScore,
  deduplicatePlacesById,
} from './utils/scoring';
import {
  addLeadsToTemporaryQueue,
  applyTtlToTemporaryQueue,
  clearTemporaryQueue,
  hasUnrecoverableSessionMapsWork,
  mapTemporaryOutcomeToCrmState,
  mergeRestoredTemporaryQueue,
  reattachSessionLeadsToTemporaryQueue,
  removeFromTemporaryQueue,
  updateTemporaryQueueEntry,
} from './utils/temporaryQueue';

type WorkspaceTab = 'explorer' | 'crm' | 'exclusions';

const ITEMS_PER_PAGE = 25;

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('explorer');
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [firebaseError, setFirebaseError] = useState<string | null>(null);
  const [mapsQuotaBanner, setMapsQuotaBanner] = useState(false);

  // Persistent user collections from Firestore (empty until authenticated)
  const [workspaceMode, setWorkspaceMode] = useState<CrmWorkspaceMode>('production');
  const [exclusions, setExclusions] = useState<ExclusionRecord[]>([]);
  const [discards, setDiscards] = useState<DiscardRecord[]>([]);
  const [productionFollowups, setProductionFollowups] = useState<FollowupLeadRecord[]>([]);
  const [sandboxFollowups, setSandboxFollowups] = useState<FollowupLeadRecord[]>([]);
  const followups = workspaceMode === 'sandbox' ? sandboxFollowups : productionFollowups;
  const [localSessionDiscards, setLocalSessionDiscards] = useState<Set<string>>(new Set());

  // Transient session search state (never bulk-persisted or exported)
  const [rawPlaces, setRawPlaces] = useState<GooglePlaceRaw[]>([]);
  const [leads, setLeads] = useState<BusinessLead[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [currentParams, setCurrentParams] = useState<SearchParams | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchNotice, setSearchNotice] = useState<string>('');
  const [currentPage, setCurrentPage] = useState(1);
  const [websiteFilter, setWebsiteFilter] = useState<WebsiteFilterOption>('all');
  const [smartFilters, setSmartFilters] = useState<SmartFilterState>(DEFAULT_SMART_FILTERS);
  const [showExcludedAndDiscarded, setShowExcludedAndDiscarded] = useState(false);
  // Cola Temporal de Sesión + Recuperación 12h/24h (0 Places Details · nunca almacena Maps restringido en Firestore/localStorage)
  const [temporaryQueue, setTemporaryQueue] = useState<TemporaryQueueEntry[]>([]);
  const temporaryQueueRef = useRef<TemporaryQueueEntry[]>([]);
  temporaryQueueRef.current = temporaryQueue;
  const [crmSubView, setCrmSubView] = useState<'temporal' | 'crm'>('temporal');
  const [temporaryTtlHours, setTemporaryTtlHours] = useState<TemporaryQueueTtlHours>(24);
  const [isSyncingTemporaryQueue, setIsSyncingTemporaryQueue] = useState(false);
  const [temporaryRestorationNotice, setTemporaryRestorationNotice] = useState<string | null>(null);
  const [checkedExplorerPlaceIds, setCheckedExplorerPlaceIds] = useState<Set<string>>(new Set());
  const leadsRef = useRef<BusinessLead[]>([]);
  leadsRef.current = leads;
  const tempSyncTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Subzone Gemini state
  const [subzones, setSubzones] = useState<string[]>([]);
  const [subzoneRationale, setSubzoneRationale] = useState('');
  const [subzoneError, setSubzoneError] = useState<string | null>(null);
  const [isLoadingSubzones, setIsLoadingSubzones] = useState(false);

  // Quota, map, drawer & auto-qualifier state
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [verifyingPlaceId, setVerifyingPlaceId] = useState<string | null>(null);
  const [isBatchVerifying, setIsBatchVerifying] = useState(false);
  const [qualifierOpen, setQualifierOpen] = useState(false);
  const [isQualifying, setIsQualifying] = useState(false);
  const [qualifierProgress, setQualifierProgress] = useState('');
  const [qualifierGeminiWarning, setQualifierGeminiWarning] = useState<string | null>(null);
  const [qualificationResults, setQualificationResults] = useState<LeadQualificationResult[]>([]);
  const [qualificationSummary, setQualificationSummary] = useState<QualifierBatchSummary | null>(
    null
  );
  const [isTransferringPreselected, setIsTransferringPreselected] = useState(false);

  // Shared session-only Place Details hydration cache (survives tab switches, TTL 30m, never persisted or exported)
  const [hydrationCache, setHydrationCache] = useState<Record<string, PlaceHydrationEntry>>({});
  const hydrationCacheRef = useRef<Record<string, PlaceHydrationEntry>>({});
  hydrationCacheRef.current = hydrationCache;
  const inFlightPlaceIdsRef = useRef<Set<string>>(new Set());

  const [placesQuotaBlock, setPlacesQuotaBlock] = useState<PlacesQuotaBlockState>({
    blocked: false,
    source: 'none',
    message: null,
  });
  const placesQuotaBlockRef = useRef<PlacesQuotaBlockState>(placesQuotaBlock);
  placesQuotaBlockRef.current = placesQuotaBlock;

  const syncQuotaFromServer = useCallback((q?: QuotaStatus | null) => {
    if (!q) return;
    setQuota(q);
    if (q.googleQuotaBlocked) {
      setMapsQuotaBanner(true);
      setPlacesQuotaBlock({
        blocked: true,
        source: 'google_resource_exhausted',
        message:
          q.googleQuotaBlockedMessage ||
          'Google Places API (New) reportó cuota agotada (429 RESOURCE_EXHAUSTED).',
      });
    } else if (q.placesUsed >= q.placesLimit) {
      setPlacesQuotaBlock({
        blocked: true,
        source: 'local_preventive_limit',
        message:
          'Se alcanzó el límite diario preventivo local configurado en este servidor (independiente de la cuota real de Google).',
      });
    } else {
      setPlacesQuotaBlock({ blocked: false, source: 'none', message: null });
    }
  }, []);

  useEffect(() => {
    const onQuotaExceeded = () => {
      setMapsQuotaBanner(true);
      setPlacesQuotaBlock((prev) =>
        prev.source === 'google_resource_exhausted'
          ? prev
          : {
              blocked: true,
              source: 'google_resource_exhausted',
              message:
                'Google Places API (New) devolvió 429 RESOURCE_EXHAUSTED. Las consultas se detuvieron automáticamente.',
            }
      );
    };
    window.addEventListener('gmp-quota-exceeded', onQuotaExceeded);
    testFirestoreConnection();
    fetchQuotaStatus().then((q) => {
      if (q) syncQuotaFromServer(q);
    });

    const unsubAuth = subscribeToAuth((u) => {
      setUser(u);
      setAuthReady(true);
    });

    return () => {
      window.removeEventListener('gmp-quota-exceeded', onQuotaExceeded);
      unsubAuth();
    };
  }, [syncQuotaFromServer]);

  useEffect(() => {
    if (!authReady || !user || !user.emailVerified) {
      setExclusions([]);
      setDiscards([]);
      setProductionFollowups([]);
      setSandboxFollowups([]);
      return;
    }

    const unsubExcl = subscribeUserExclusions(
      user.uid,
      (items) => setExclusions(items),
      (msg) => setFirebaseError(msg)
    );
    const unsubDisc = subscribeUserDiscards(
      user.uid,
      (items) => setDiscards(items),
      (msg) => setFirebaseError(msg)
    );
    const unsubProd = subscribeUserFollowups(
      user.uid,
      (items) => setProductionFollowups(items),
      (msg) => setFirebaseError(msg),
      'production'
    );
    const unsubSandbox = subscribeUserFollowups(
      user.uid,
      (items) => setSandboxFollowups(items),
      (msg) => setFirebaseError(msg),
      'sandbox'
    );

    return () => {
      unsubExcl();
      unsubDisc();
      unsubProd();
      unsubSandbox();
    };
  }, [authReady, user]);

  // Recuperación automática (< 12h/24h) de Cola Temporal desde Firestore al iniciar/restaurar sesión
  // Nunca borra temporaryQueue al cerrar sesión ni hace llamadas a Google Place Details.
  useEffect(() => {
    if (!authReady || !user || !user.emailVerified) {
      return;
    }

    let cancelled = false;
    const uid = user.uid;

    (async () => {
      try {
        setIsSyncingTemporaryQueue(true);
        const { activeItems, expiredPlaceIds } = await fetchActiveTemporaryWorkQueue(uid);
        if (cancelled) return;

        if (expiredPlaceIds.length > 0) {
          void deleteTemporaryWorkItemsBatch(uid, expiredPlaceIds).catch(() => {});
        }

        const preLoginInMemory = temporaryQueueRef.current;
        const mergeOutcome = mergeRestoredTemporaryQueue(
          preLoginInMemory,
          activeItems,
          leadsRef.current
        );
        setTemporaryQueue(mergeOutcome.mergedQueue);

        // Si había ítems agregados en sesión antes de iniciar sesión, respaldar sus campos permitidos en Firestore
        const persistedIds = new Set(activeItems.map((i) => i.placeId));
        const unpersistedSessionItems = preLoginInMemory.filter(
          (e) => !persistedIds.has(e.placeId)
        );
        if (unpersistedSessionItems.length > 0) {
          await upsertTemporaryWorkItemsBatch(uid, unpersistedSessionItems, temporaryTtlHours);
        }

        if (mergeOutcome.restoredCount > 0) {
          const mapsHint =
            mergeOutcome.missingMapsSessionCount > 0
              ? ` (${mergeOutcome.missingMapsSessionCount} sin referencia temporal Maps en RAM; se muestran tus notas y datos propios autorizados)`
              : '';
          setTemporaryRestorationNotice(
            `Se recuperaron automáticamente ${mergeOutcome.restoredCount} prospecto(s) vigente(s) desde tu respaldo temporal${mapsHint} · 0 consultas Places.`
          );
        }
      } catch (err) {
        if (!cancelled) {
          setFirebaseError(formatFriendlyFirestoreError(err));
        }
      } finally {
        if (!cancelled) {
          setIsSyncingTemporaryQueue(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authReady, user]);

  // Si Explorador carga resultados nuevos en RAM que coinciden con ítems restaurados, re-vincular sin llamar Places
  useEffect(() => {
    if (leads.length === 0) return;
    setTemporaryQueue((prev) => reattachSessionLeadsToTemporaryQueue(prev, leads));
  }, [leads]);

  // Advertencia al intentar cerrar/recargar pestaña cuando hay datos temporales de Maps no recuperables
  useEffect(() => {
    const isSignedInVerified = Boolean(user && user.emailVerified);
    if (!hasUnrecoverableSessionMapsWork(temporaryQueue, isSignedInVerified)) {
      return;
    }
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [temporaryQueue, user]);

  const hydrateFollowupPlaceIds = useCallback(
    async (
      candidatePlaceIds: string[],
      options?: { isManualRetry?: boolean; maxBatchSize?: number }
    ) => {
      // Si la cuota real de Google o el límite preventivo local están bloqueados, NO disparar ninguna llamada
      if (placesQuotaBlockRef.current.blocked) {
        return;
      }

      const availableIds = candidatePlaceIds.filter(
        (id) => id && !inFlightPlaceIdsRef.current.has(id)
      );
      const batch = selectNextHydrationBatch(availableIds, hydrationCacheRef.current, {
        isManualRetry: options?.isManualRetry,
        maxBatchSize: Math.min(5, options?.maxBatchSize ?? 5),
      });
      if (batch.length === 0) return;

      for (const id of batch) {
        inFlightPlaceIdsRef.current.add(id);
      }

      const preSnapshot = { ...hydrationCacheRef.current };
      setHydrationCache((prev) => {
        const next = { ...prev };
        for (const id of batch) {
          const existing = prev[id];
          next[id] = {
            placeId: id,
            status: 'loading',
            details: existing?.details ?? null,
            retryCount: options?.isManualRetry ? 0 : existing?.retryCount ?? 0,
            updatedAt: Date.now(),
            expiresAt: existing?.expiresAt,
          };
        }
        return next;
      });

      try {
        const response = await fetchPlaceDetailsBatch(batch);
        if (response.quota) {
          syncQuotaFromServer(response.quota);
        }

        if (response.quotaExceeded) {
          setMapsQuotaBanner(true);
          setPlacesQuotaBlock({
            blocked: true,
            source: 'google_resource_exhausted',
            message:
              response.quota?.googleQuotaBlockedMessage ||
              response.topLevelError ||
              'Google Places API (New) devolvió 429 RESOURCE_EXHAUSTED. Consultas detenidas.',
          });
        } else if (response.localQuotaReached) {
          setPlacesQuotaBlock({
            blocked: true,
            source: 'local_preventive_limit',
            message:
              response.topLevelError ||
              'Se alcanzó el límite preventivo diario local configurado en el servidor.',
          });
        }

        const baseForMerge = options?.isManualRetry
          ? Object.fromEntries(
              Object.entries(preSnapshot).map(([k, v]) => [
                k,
                batch.includes(k) ? { ...v, retryCount: 0 } : v,
              ])
            )
          : preSnapshot;

        const merged = mergeHydrationBatchResults(baseForMerge, batch, response.results);
        setHydrationCache((prev) => ({ ...prev, ...merged }));
      } finally {
        for (const id of batch) {
          inFlightPlaceIdsRef.current.delete(id);
        }
      }
    },
    [syncQuotaFromServer]
  );

  const exclusionKeys = useMemo(() => buildExclusionKeySet(exclusions), [exclusions]);
  const exclusionPlaceIds = useMemo(
    () =>
      new Set(
        exclusions.filter((e) => e.type === 'placeId').map((e) => e.normalizedValue)
      ),
    [exclusions]
  );
  const discardedPlaceIds = useMemo(() => {
    const set = new Set<string>(localSessionDiscards);
    for (const d of discards) set.add(d.placeId);
    return set;
  }, [discards, localSessionDiscards]);

  // Re-evaluate exclusion matches whenever exclusions change
  useEffect(() => {
    setLeads((prev) =>
      prev.map((lead) => {
        const rawMatch = rawPlaces.find((r) => r.placeId === lead.placeId);
        if (!rawMatch) return lead;
        const match = checkPlaceAgainstExclusions(rawMatch, exclusionKeys);
        return { ...lead, exclusionMatch: match };
      })
    );
  }, [exclusionKeys, rawPlaces]);

  const handleSignIn = async () => {
    setFirebaseError(null);
    try {
      await signInWithGooglePopup();
    } catch (err) {
      setFirebaseError(formatFriendlyFirestoreError(err));
    }
  };

  const handleSignOut = async () => {
    await signOutFirebase();
  };

  const seedSessionHydrationCache = useCallback((placesList: GooglePlaceRaw[]) => {
    if (!placesList || placesList.length === 0) return;
    const now = Date.now();
    setHydrationCache((prev) => {
      const next = { ...prev };
      for (const r of placesList) {
        if (!r.placeId || r.placeId.startsWith('manual_')) continue;
        next[r.placeId] = {
          placeId: r.placeId,
          status: 'loaded',
          details: {
            placeId: r.placeId,
            displayName: r.displayName,
            formattedAddress: r.formattedAddress,
            nationalPhoneNumber: r.nationalPhoneNumber ?? null,
            internationalPhoneNumber: r.internationalPhoneNumber ?? null,
            websiteUri: r.websiteUri ?? null,
            googleMapsUri: r.googleMapsUri,
            businessStatus: r.businessStatus,
          },
          retryCount: 0,
          updatedAt: now,
          expiresAt: now + SESSION_CACHE_TTL_MS,
        };
      }
      return next;
    });
  }, []);

  const handleSearch = async (params: SearchParams) => {
    setIsLoading(true);
    setSearchError(null);
    setSearchNotice('');
    setCurrentParams(params);
    setCurrentPage(1);
    setSelectedPlaceId(null);

    try {
      const response = await searchPlacesPage(params);
      syncQuotaFromServer(response.quota);
      const uniqueRaw = deduplicatePlacesById([], response.places);
      setRawPlaces(uniqueRaw);
      // Sembrar caché de sesión directamente desde Explorador (0 llamadas Place Details)
      seedSessionHydrationCache(uniqueRaw);

      const built = uniqueRaw.map((r) =>
        buildBusinessLeadFromPlace(r, params.businessType, exclusionKeys)
      );
      setLeads(built);
      setNextPageToken(response.nextPageToken);

      if (built.length === 0) {
        setSearchNotice('No se encontraron establecimientos para esa búsqueda en Places API (New).');
      } else {
        setSearchNotice(
          `${built.length} negocios únicos por Place ID cargados${
            response.fromCache ? ' (desde caché para proteger cuota)' : ''
          }.`
        );
      }
    } catch (err: any) {
      if (err?.quota) syncQuotaFromServer(err.quota);
      setRawPlaces([]);
      setLeads([]);
      setNextPageToken(null);
      setSearchError(err?.message || 'Error consultando Google Places API (New).');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadNextPage = async () => {
    if (!currentParams || !nextPageToken || isLoading) return;
    setIsLoading(true);
    setSearchError(null);

    try {
      const response = await searchPlacesPage(currentParams, nextPageToken);
      syncQuotaFromServer(response.quota);
      const mergedRaw = deduplicatePlacesById(rawPlaces, response.places);
      const newOnly = mergedRaw.slice(rawPlaces.length);
      setRawPlaces(mergedRaw);
      seedSessionHydrationCache(newOnly);

      const builtNew = newOnly.map((r) =>
        buildBusinessLeadFromPlace(r, currentParams.businessType, exclusionKeys)
      );
      setLeads((prev) => [...prev, ...builtNew]);
      setNextPageToken(response.nextPageToken);
      setSearchNotice(
        `Página adicional cargada: +${builtNew.length} negocios únicos (total ${mergedRaw.length}).`
      );
    } catch (err: any) {
      if (err?.quota) syncQuotaFromServer(err.quota);
      setSearchError(err?.message || 'No se pudo cargar la siguiente página.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSuggestSubzones = async (location: string, businessType: string) => {
    setIsLoadingSubzones(true);
    setSubzoneError(null);
    try {
      const res = await fetchSubzoneSuggestions(location, businessType);
      setSubzones(res.subzones);
      setSubzoneRationale(res.rationale);
      setQuota(res.quota);
    } catch (err: any) {
      if (err?.quota) setQuota(err.quota);
      setSubzoneError(err?.message || 'Error al obtener subzonas sugeridas con Gemini.');
    } finally {
      setIsLoadingSubzones(false);
    }
  };

  const handleVerifyWebsite = useCallback(async (lead: BusinessLead, overrideUrl?: string) => {
    const targetUrl = (overrideUrl || lead.website || '').trim();
    if (!targetUrl) return;
    setVerifyingPlaceId(lead.placeId);
    try {
      const probe = await verifyWebsiteUrl(targetUrl);
      setLeads((prev) =>
        prev.map((item) => {
          if (item.placeId !== lead.placeId) return item;
          const nextProbe = item.confirmedNoWebsite
            ? { ...item.websiteProbe, status: 'confirmed_none' as const }
            : probe;
          return {
            ...item,
            websiteProbe: nextProbe,
            digitalScore: computeDigitalOpportunityScore(nextProbe, item.confirmedNoWebsite, {
              category: item.category,
            }),
            trustScore: computeInformationTrustScore({
              businessStatus: item.businessStatus,
              independentPhone: item.independentPhone,
              confirmedNoWebsite: item.confirmedNoWebsite,
              independentCategory: item.category,
              websiteProbe: nextProbe,
              lastVerifiedAt: nextProbe.verifiedAt,
            }),
          };
        })
      );
    } finally {
      setVerifyingPlaceId(null);
    }
  }, []);

  const handleBatchVerifyVisible = async () => {
    const candidates = paginatedLeads.filter(
      (l) => l.website && l.websiteProbe.provenance === 'google_absent'
    );
    if (candidates.length === 0) return;
    setIsBatchVerifying(true);
    try {
      for (const item of candidates) {
        await handleVerifyWebsite(item);
      }
    } finally {
      setIsBatchVerifying(false);
    }
  };

  const handleUpdateIndependentFields = (
    placeId: string,
    patch: {
      confirmedNoWebsite: boolean;
      independentPhone: string;
      phoneStage: PhoneVerificationStage;
      independentEmail: string;
      independentWebsiteNote: string;
    }
  ) => {
    setLeads((prev) =>
      prev.map((lead) => {
        if (lead.placeId !== placeId) return lead;
        const nextProbe = patch.confirmedNoWebsite
          ? {
              ...lead.websiteProbe,
              status: 'confirmed_none' as const,
              summary: 'Confirmado manualmente sin sitio web propio',
              provenance: 'manual_user' as const,
              verifiedAt: new Date().toISOString(),
            }
          : lead.websiteProbe.status === 'confirmed_none'
          ? {
              ...lead.websiteProbe,
              status: lead.website ? ('unverified_inconclusive' as const) : ('unregistered' as const),
              summary: lead.website
                ? 'Registrada en Google (sin verificar HTTP aún)'
                : 'Sin web registrada en Google Maps',
              provenance: 'google_absent' as const,
            }
          : lead.websiteProbe;

        const independentPhoneParsed = analyzePeruvianPhone(patch.independentPhone, patch.phoneStage);
        const nextGooglePhone = {
          ...lead.phoneAnalysis,
          stage:
            patch.phoneStage === 'independently_corroborated' ||
            patch.phoneStage === 'contact_reached'
              ? patch.phoneStage
              : lead.phoneAnalysis.stage,
        };

        const nextDigital = computeDigitalOpportunityScore(nextProbe, patch.confirmedNoWebsite, {
          category: lead.category,
        });
        const nextContact = computeContactabilityScore(
          nextGooglePhone,
          independentPhoneParsed,
          patch.independentEmail
        );
        const nextTrust = computeInformationTrustScore({
          businessStatus: lead.businessStatus,
          independentPhone: independentPhoneParsed.formatted || patch.independentPhone.trim(),
          confirmedNoWebsite: patch.confirmedNoWebsite,
          independentCategory: lead.category,
          websiteProbe: nextProbe,
          lastVerifiedAt: new Date().toISOString(),
        });

        return {
          ...lead,
          confirmedNoWebsite: patch.confirmedNoWebsite,
          independentPhone: independentPhoneParsed.formatted || patch.independentPhone.trim(),
          independentEmail: patch.independentEmail.trim(),
          independentWebsiteNote: patch.independentWebsiteNote,
          phoneAnalysis: nextGooglePhone,
          websiteProbe: nextProbe,
          digitalScore: nextDigital,
          contactabilityScore: nextContact,
          trustScore: nextTrust,
        };
      })
    );
  };

  const handleDiscardPlace = async (lead: BusinessLead, reason: string = 'Descartado manualmente') => {
    setLocalSessionDiscards((prev) => new Set(prev).add(lead.placeId));
    if (selectedPlaceId === lead.placeId) setSelectedPlaceId(null);

    if (user && user.emailVerified) {
      try {
        await saveDiscardPlace(user.uid, lead.placeId, reason);
      } catch (err) {
        setFirebaseError(formatFriendlyFirestoreError(err));
      }
    }
  };

  const handleRestoreDiscard = async (placeId: string) => {
    setLocalSessionDiscards((prev) => {
      const next = new Set(prev);
      next.delete(placeId);
      return next;
    });
    if (user && user.emailVerified) {
      try {
        await removeDiscardPlace(user.uid, placeId);
      } catch (err) {
        setFirebaseError(formatFriendlyFirestoreError(err));
      }
    }
  };

  const handlePromoteToFollowup = async (
    lead: BusinessLead,
    independentData: DrawerPromoteIndependentData
  ): Promise<CreateFollowupOutcome> => {
    if (!user || !user.emailVerified) {
      throw new Error('Inicia sesión con Google para guardar seguimientos en Firestore.');
    }

    const phoneParsed = analyzePeruvianPhone(
      independentData.independentPhone,
      independentData.phoneStage
    );
    const resolvedWebsiteStatus = resolveIndependentWebsiteStatusForSave({
      independentWebsite: independentData.independentWebsite,
      confirmedNoWebsite: independentData.confirmedNoWebsite,
      verifiedProbe: lead.websiteProbe,
    });
    const nextProbe = { ...lead.websiteProbe, status: resolvedWebsiteStatus };

    const digitalEval = computeDigitalOpportunityScore(
      nextProbe,
      independentData.confirmedNoWebsite,
      { category: independentData.independentCategory || lead.category }
    );
    const contactEval = computeContactabilityScore(
      lead.phoneAnalysis,
      phoneParsed,
      independentData.independentEmail,
      { legalBasis: independentData.legalBasis }
    );
    const completeness = evaluateFollowupCompleteness({
      independentBusinessName: independentData.independentBusinessName,
      independentPhone: independentData.independentPhone,
      independentAddress: independentData.independentAddress,
      district: independentData.district,
      independentWebsite: independentData.independentWebsite,
      confirmedNoWebsite: independentData.confirmedNoWebsite,
      independentEmail: independentData.independentEmail,
      independentCategory: independentData.independentCategory,
    });

    const hasLegalAuthorization = (independentData.legalBasis || '').trim().length >= 8;

    const outcome = await createFollowupRecord(
      user.uid,
      {
        placeId: lead.placeId,
        sourceKind: independentData.sourceKind,
        independentBusinessName: independentData.independentBusinessName,
        district: independentData.district,
        independentAddress: independentData.independentAddress,
        independentWebsite: independentData.independentWebsite,
        independentCategory: independentData.independentCategory,
        confirmedNoWebsite: independentData.confirmedNoWebsite,
        independentWebsiteStatus: resolvedWebsiteStatus,
        independentPhone: independentData.independentPhone,
        independentPhoneType: independentData.independentPhoneType,
        phoneStage: independentData.phoneStage,
        independentEmail: independentData.independentEmail,
        independentDigitalScore: digitalEval.score,
        independentContactScore: contactEval.score,
        independentTrustScore: independentData.independentTrustScore,
        completenessStatus: completeness.status,
        stage: hasLegalAuthorization ? 'CONTACTO AUTORIZADO' : 'PENDIENTE DE VERIFICACIÓN',
        legalBasis: independentData.legalBasis,
        qualificationTier: '',
        aiSummary: '',
        notes: independentData.notes,
        verificationSummary: independentData.verificationSummary,
        lastVerifiedAt: independentData.lastVerifiedAt,
        verificationSources: independentData.verificationSources,
      },
      workspaceMode
    );

    const rawPlace = rawPlaces.find((r) => r.placeId === lead.placeId);
    if (rawPlace) {
      seedSessionHydrationCache([rawPlace]);
    }

    return outcome;
  };

  const handleRunAutoQualifier = async () => {
    if (leads.length === 0) return;
    setQualifierOpen(true);
    setIsQualifying(true);
    setQualifierGeminiWarning(null);
    setQualifierProgress(
      `Verificando URLs pendientes en los ${leads.length} resultados cargados...`
    );

    try {
      // 1. Verificar URLs aún no comprobadas para los negocios móviles o no excluidos (en todo el lote cargado)
      const leadsSnapshot = [...leads];
      const existingSet = new Set(followups.map((f) => f.placeId));
      const toProbe = leadsSnapshot.filter(
        (l) =>
          l.website &&
          l.websiteProbe.provenance === 'google_absent' &&
          !l.exclusionMatch.excluded &&
          !discardedPlaceIds.has(l.placeId) &&
          !existingSet.has(l.placeId)
      );

      const probedMap = new Map<string, BusinessLead['websiteProbe']>();
      const PROBE_CONCURRENCY = 4;
      for (let i = 0; i < toProbe.length; i += PROBE_CONCURRENCY) {
        const chunk = toProbe.slice(i, i + PROBE_CONCURRENCY);
        setQualifierProgress(
          `Verificando sitios web independientes (${Math.min(
            i + chunk.length,
            toProbe.length
          )}/${toProbe.length})...`
        );
        const results = await Promise.all(chunk.map((item) => verifyWebsiteUrl(item.website)));
        chunk.forEach((item, idx) => {
          probedMap.set(item.placeId, results[idx]);
        });
      }

      const updatedLeads = leadsSnapshot.map((item) => {
        const probe = probedMap.get(item.placeId);
        if (!probe || item.confirmedNoWebsite) return item;
        return {
          ...item,
          websiteProbe: probe,
          digitalScore: computeDigitalOpportunityScore(probe, item.confirmedNoWebsite, {
            category: item.category,
          }),
          trustScore: computeInformationTrustScore({
            businessStatus: item.businessStatus,
            independentPhone: item.independentPhone,
            confirmedNoWebsite: item.confirmedNoWebsite,
            independentCategory: item.category,
            websiteProbe: probe,
            lastVerifiedAt: probe.verifiedAt,
          }),
        };
      });
      setLeads(updatedLeads);

      // 2. Calificación determinística prioritaria sobre TODOS los resultados cargados (0 llamadas Gemini)
      setQualifierProgress('Ejecutando clasificación determinística WEBNEX (0 llamadas Gemini)...');
      const deterministic = qualifyLoadedLeadsBatch(updatedLeads, {
        discardedPlaceIds,
        existingFollowups: followups,
      });

      // Ordenar priorizando PRIORIDAD ALTA > REVISIÓN PENDIENTE > NO ELEGIBLE (móvil válido, sin web o solo social primero)
      const tierWeight = (tier: LeadQualificationResult['tier']): number =>
        tier === 'PRIORIDAD ALTA' ? 0 : tier === 'REVISIÓN PENDIENTE' ? 1 : 2;
      const sortedResults = [...deterministic.results].sort((a, b) => {
        const diff = tierWeight(a.tier) - tierWeight(b.tier);
        if (diff !== 0) return diff;
        return b.combinedPriorityScore - a.combinedPriorityScore;
      });

      setQualificationResults(sortedResults);
      setQualificationSummary(deterministic.summary);
      setQualifierGeminiWarning(
        'Preselección ejecutada por reglas determinísticas WEBNEX (0 llamadas Gemini · 0 consultas Places Details).'
      );
    } finally {
      setIsQualifying(false);
    }
  };

  // FASE 1 & 2 — Gestión de TemporaryLeadQueue estrictamente en memoria de sesión (0 llamadas Places Details)
  const queuedPlaceIds = useMemo(
    () => new Set(temporaryQueue.map((item) => item.placeId)),
    [temporaryQueue]
  );

  const syncEntriesToFirestore = useCallback(
    async (entries: TemporaryQueueEntry[], ttlHours: TemporaryQueueTtlHours) => {
      if (!user || !user.emailVerified || entries.length === 0) return;
      setIsSyncingTemporaryQueue(true);
      try {
        await upsertTemporaryWorkItemsBatch(user.uid, entries, ttlHours);
      } catch (err) {
        setFirebaseError(formatFriendlyFirestoreError(err));
      } finally {
        setIsSyncingTemporaryQueue(false);
      }
    },
    [user]
  );

  const handleAddLeadsToTemporaryQueue = useCallback(
    (targetLeads: BusinessLead[]) => {
      if (targetLeads.length === 0) return;
      const outcome = addLeadsToTemporaryQueue(temporaryQueue, targetLeads, {
        district: currentParams?.location || '',
        category: currentParams?.businessType || '',
        ttlHours: temporaryTtlHours,
      });
      setTemporaryQueue(outcome.queue);

      if (outcome.addedPlaceIds.length > 0 && user && user.emailVerified) {
        const addedSet = new Set(outcome.addedPlaceIds);
        const justAdded = outcome.queue.filter((e) => addedSet.has(e.placeId));
        void syncEntriesToFirestore(justAdded, temporaryTtlHours);
      }

      setSearchNotice(
        outcome.addedCount > 0
          ? `Cola temporal actualizada: +${outcome.addedCount} negocio(s) agregado(s)${
              outcome.skippedDuplicates > 0
                ? `, ${outcome.skippedDuplicates} duplicado(s) omitido(s)`
                : ''
            } · 0 llamadas Place Details.`
          : `Sin cambios en cola temporal: los ${outcome.skippedDuplicates} negocio(s) seleccionado(s) ya estaban en cola.`
      );
    },
    [
      temporaryQueue,
      temporaryTtlHours,
      currentParams?.location,
      currentParams?.businessType,
      user,
      syncEntriesToFirestore,
    ]
  );

  const handleToggleCheckPlace = useCallback((placeId: string) => {
    setCheckedExplorerPlaceIds((prev) => {
      const next = new Set(prev);
      if (next.has(placeId)) next.delete(placeId);
      else next.add(placeId);
      return next;
    });
  }, []);

  const handleUpdateTemporaryEntry = useCallback(
    (
      placeId: string,
      patch: Partial<{
        outcome: TemporaryQueueOutcome;
        notes: string;
        followUpDate: string;
        priorityLabel: TemporaryQueuePriority;
        isSelected: boolean;
        independentData: Partial<TemporaryQueueIndependentDraft>;
      }>
    ) => {
      let updatedEntry: TemporaryQueueEntry | undefined;
      setTemporaryQueue((prev) => {
        const next = updateTemporaryQueueEntry(prev, placeId, {
          ...patch,
          ttlHours: temporaryTtlHours,
        });
        updatedEntry = next.find((e) => e.placeId === placeId);
        return next;
      });

      if (user && user.emailVerified) {
        const existingTimer = tempSyncTimersRef.current.get(placeId);
        if (existingTimer) clearTimeout(existingTimer);
        const delayMs = patch.notes !== undefined || patch.independentData ? 450 : 120;
        const timer = setTimeout(() => {
          tempSyncTimersRef.current.delete(placeId);
          const latest =
            updatedEntry || temporaryQueueRef.current.find((e) => e.placeId === placeId);
          if (latest) {
            void syncEntriesToFirestore([latest], temporaryTtlHours);
          }
        }, delayMs);
        tempSyncTimersRef.current.set(placeId, timer);
      }
    },
    [user, temporaryTtlHours, syncEntriesToFirestore]
  );

  const handleChangeTemporaryTtlHours = useCallback(
    (hours: TemporaryQueueTtlHours) => {
      setTemporaryTtlHours(hours);
      const updated = applyTtlToTemporaryQueue(temporaryQueueRef.current, hours);
      setTemporaryQueue(updated);
      if (user && user.emailVerified && updated.length > 0) {
        void syncEntriesToFirestore(updated, hours);
      }
    },
    [user, syncEntriesToFirestore]
  );

  const handleRemoveTemporarySelected = useCallback(
    (placeIds: string[]) => {
      for (const id of placeIds) {
        const timer = tempSyncTimersRef.current.get(id);
        if (timer) {
          clearTimeout(timer);
          tempSyncTimersRef.current.delete(id);
        }
      }
      setTemporaryQueue((prev) => removeFromTemporaryQueue(prev, placeIds));
      if (user && user.emailVerified && placeIds.length > 0) {
        void deleteTemporaryWorkItemsBatch(user.uid, placeIds).catch((err) => {
          setFirebaseError(formatFriendlyFirestoreError(err));
        });
      }
    },
    [user]
  );

  const handleClearTemporaryQueue = useCallback(() => {
    for (const timer of tempSyncTimersRef.current.values()) {
      clearTimeout(timer);
    }
    tempSyncTimersRef.current.clear();
    const idsToDelete = temporaryQueueRef.current.map((e) => e.placeId);
    setTemporaryQueue(clearTemporaryQueue());
    if (user && user.emailVerified && idsToDelete.length > 0) {
      void deleteTemporaryWorkItemsBatch(user.uid, idsToDelete).catch((err) => {
        setFirebaseError(formatFriendlyFirestoreError(err));
      });
    }
  }, [user]);

  const handlePromoteTemporaryEntryToCrm = useCallback(
    async (entry: TemporaryQueueEntry): Promise<string | null> => {
      if (!user || !user.emailVerified) {
        throw new Error('Inicia sesión con Google para trasladar fichas al CRM definitivo.');
      }
      const ind = entry.independentData;
      const nowIso = new Date().toISOString();
      const phoneParsed = analyzePeruvianPhone(
        ind.independentPhone,
        ind.independentPhone.trim() ? 'independently_corroborated' : 'none'
      );
      const formattedPhone = phoneParsed.formatted || ind.independentPhone.trim();
      const resolvedWebsiteStatus = resolveIndependentWebsiteStatusForSave({
        independentWebsite: ind.independentWebsite,
        confirmedNoWebsite: ind.confirmedNoWebsite,
        verifiedProbe: entry.lead.websiteProbe,
      });
      const nextProbe = { ...entry.lead.websiteProbe, status: resolvedWebsiteStatus };
      const digitalEval = computeDigitalOpportunityScore(nextProbe, ind.confirmedNoWebsite, {
        category: ind.independentCategory || entry.lead.category,
      });
      const contactEval = computeContactabilityScore(
        entry.lead.phoneAnalysis,
        phoneParsed,
        ind.independentEmail,
        { legalBasis: ind.legalBasis }
      );
      const completeness = evaluateFollowupCompleteness({
        independentBusinessName: ind.independentBusinessName,
        independentPhone: formattedPhone,
        independentAddress: ind.independentAddress,
        district: ind.district,
        independentWebsite: ind.independentWebsite,
        confirmedNoWebsite: ind.confirmedNoWebsite,
        independentEmail: ind.independentEmail,
        independentCategory: ind.independentCategory,
      });
      const trustEval = computeInformationTrustScore({
        businessStatus: entry.lead.businessStatus,
        independentBusinessName: ind.independentBusinessName,
        independentPhone: formattedPhone,
        independentAddress: ind.independentAddress,
        district: ind.district,
        independentWebsite: ind.independentWebsite,
        confirmedNoWebsite: ind.confirmedNoWebsite,
        independentCategory: ind.independentCategory,
        websiteProbe: nextProbe,
        verificationSourcesCount: 1,
        lastVerifiedAt: nowIso,
      });
      const crmState = mapTemporaryOutcomeToCrmState(entry.outcome, ind.legalBasis);

      const sources: string[] = [];
      const pushSource = (field: string, evidence: string) => {
        if (!evidence.trim()) return;
        sources.push(
          encodeVerificationProvenanceEntry({
            field,
            source: 'user_manual_entry',
            evidence: evidence.trim(),
            verifiedAt: nowIso,
          })
        );
      };
      pushSource('nombre', ind.independentBusinessName);
      pushSource('teléfono', formattedPhone);
      pushSource('dirección', ind.independentAddress);
      pushSource('distrito', ind.district);
      pushSource('web', ind.independentWebsite);
      pushSource('correo', ind.independentEmail);
      pushSource('categoría', ind.independentCategory);

      const outcome = await createFollowupRecord(
        user.uid,
        {
          placeId: entry.placeId,
          sourceKind: ind.independentBusinessName.trim()
            ? 'independent_manual'
            : 'places_preselection',
          independentBusinessName: ind.independentBusinessName.trim(),
          district: ind.district.trim(),
          independentAddress: ind.independentAddress.trim(),
          independentWebsite: ind.independentWebsite.trim(),
          independentCategory: ind.independentCategory.trim(),
          confirmedNoWebsite: ind.confirmedNoWebsite,
          independentWebsiteStatus: resolvedWebsiteStatus,
          independentPhone: formattedPhone,
          independentPhoneType: resolveIndependentPhoneType(formattedPhone),
          phoneStage: formattedPhone ? 'independently_corroborated' : 'none',
          independentEmail: ind.independentEmail.trim(),
          independentDigitalScore: digitalEval.score,
          independentContactScore: contactEval.score,
          independentTrustScore: trustEval.score,
          completenessStatus: completeness.status,
          stage: crmState.stage,
          legalBasis: ind.legalBasis.trim(),
          commercialOutcome: crmState.commercialOutcome,
          outcomeSource:
            crmState.commercialOutcome !== 'none' ? 'cola_temporal_webnex' : undefined,
          outcomeRecordedAt: crmState.commercialOutcome !== 'none' ? nowIso : undefined,
          qualificationTier: '',
          aiSummary: '',
          notes: entry.notes.trim(),
          verificationSummary: 'Trasladado desde Cola Temporal con datos independientes corroborados.',
          lastVerifiedAt: nowIso,
          verificationSources: sources.slice(0, 8),
        },
        workspaceMode
      );

      setTemporaryQueue((prev) =>
        updateTemporaryQueueEntry(prev, entry.placeId, { promotedToCrmId: outcome.id })
      );
      return outcome.id;
    },
    [user, workspaceMode]
  );

  const handleConfirmTransferPreselected = async (selectedItems: PreparedTransferItem[]) => {
    if (!user || !user.emailVerified) {
      setFirebaseError('Inicia sesión con Google para guardar preselecciones en Firestore.');
      return;
    }

    setIsTransferringPreselected(true);
    try {
      const existingPlaceIds = new Set(followups.map((f) => f.placeId));
      const rawToSeed: GooglePlaceRaw[] = [];

      const payloadItems = selectedItems.map(({ result: res, draft }) => {
        const lead = leads.find((l) => l.placeId === res.placeId);
        const rawMatch = rawPlaces.find((r) => r.placeId === res.placeId);
        if (rawMatch) rawToSeed.push(rawMatch);

        const aiText = res.geminiAnalysis
          ? [
              res.geminiAnalysis.commercialRelevance,
              res.geminiAnalysis.recommendedWebnexServices.length > 0
                ? `Servicios: ${res.geminiAnalysis.recommendedWebnexServices.join(', ')}`
                : '',
            ]
              .filter(Boolean)
              .join(' | ')
          : '';

        const phoneFormatted =
          analyzePeruvianPhone(draft.independentPhone).formatted || draft.independentPhone.trim();

        const completeness = evaluateFollowupCompleteness({
          independentBusinessName: draft.independentBusinessName,
          independentPhone: phoneFormatted,
          independentAddress: draft.independentAddress,
          district: draft.district,
          independentWebsite: draft.independentWebsite,
          confirmedNoWebsite: draft.confirmedNoWebsite || Boolean(lead?.confirmedNoWebsite),
          independentEmail: draft.independentEmail,
          independentCategory: draft.independentCategory,
        });

        const confirmedNoWeb = draft.confirmedNoWebsite || Boolean(lead?.confirmedNoWebsite);
        const resolvedWebsiteStatus = resolveIndependentWebsiteStatusForSave({
          independentWebsite: draft.independentWebsite,
          confirmedNoWebsite: confirmedNoWeb,
          verifiedProbe: lead?.websiteProbe,
        });

        return {
          placeId: res.placeId,
          independentBusinessName: draft.independentBusinessName,
          district: draft.district,
          independentPhone: phoneFormatted,
          independentPhoneType: resolveIndependentPhoneType(
            phoneFormatted,
            draft.independentPhoneType
          ),
          independentAddress: draft.independentAddress,
          independentWebsite: draft.independentWebsite,
          independentEmail: draft.independentEmail,
          independentCategory: draft.independentCategory,
          verificationSummary: draft.verificationSummary,
          lastVerifiedAt: draft.lastVerifiedAt,
          verificationSources: draft.verificationSources,
          confirmedNoWebsite: confirmedNoWeb,
          independentWebsiteStatus: resolvedWebsiteStatus,
          phoneStage: phoneFormatted
            ? ('independently_corroborated' as const)
            : lead?.phoneAnalysis.stage || 'none',
          independentDigitalScore: res.digitalScore,
          independentContactScore: res.contactabilityScore,
          independentTrustScore: res.trustScore,
          completenessStatus: completeness.status,
          stage:
            res.tier === 'PRIORIDAD ALTA' &&
            completeness.status === 'complete' &&
            !draft.hasResearchContradictions
              ? ('PRESELECCIONADO' as const)
              : ('PENDIENTE DE VERIFICACIÓN' as const),
          qualificationTier: res.tier,
          aiSummary: aiText,
          notes: draft.notes || res.reasons.join(' '),
        };
      });

      const outcome = await createBatchPreselectedFollowups(
        user.uid,
        payloadItems,
        existingPlaceIds,
        workspaceMode
      );

      // Reutilizar los resultados ya cargados en sesión de Explorador sin repetir llamadas Place Details
      seedSessionHydrationCache(rawToSeed);

      const pendingCount = payloadItems.filter(
        (item) => item.stage === 'PENDIENTE DE VERIFICACIÓN'
      ).length;
      setQualifierOpen(false);
      setSearchNotice(
        `Transferencia verificada desde Firestore (${
          workspaceMode === 'sandbox' ? 'Sandbox Aislado' : 'Seguimiento'
        }): ${outcome.created} guardadas (${outcome.completeCreated} completas 4/4, ${outcome.partialCreated} incompletas/parciales, ${pendingCount} en PENDIENTE DE VERIFICACIÓN, ${outcome.skippedDuplicates} ya existían intactas) · 0 llamadas Place Details.`
      );
    } catch (err) {
      setFirebaseError(formatFriendlyFirestoreError(err));
    } finally {
      setIsTransferringPreselected(false);
    }
  };

  const { followupByPlaceId } = useMemo(
    () => buildCrmAndDuplicateSets(leads, followups),
    [leads, followups]
  );

  const filteredLeads = useMemo(() => {
    return leads
      .filter((lead) => {
        if (
          !matchesSmartFilters(lead, smartFilters, {
            discardedPlaceIds,
            followupByPlaceId,
            showExcludedAndDiscarded,
          })
        ) {
          return false;
        }

        if (currentParams?.maxReviews && currentParams.maxReviews > 0) {
          if (lead.reviewsNumeric !== null && lead.reviewsNumeric > currentParams.maxReviews) {
            return false;
          }
        }

        switch (websiteFilter) {
          case 'no_website_any':
            return (
              lead.websiteProbe.status === 'unregistered' ||
              lead.websiteProbe.status === 'confirmed_none' ||
              lead.confirmedNoWebsite
            );
          case 'unregistered':
            return lead.websiteProbe.status === 'unregistered';
          case 'confirmed_none':
            return lead.websiteProbe.status === 'confirmed_none' || lead.confirmedNoWebsite;
          case 'social_only':
            return lead.websiteProbe.status === 'social_only';
          case 'unreachable_verified':
            return lead.websiteProbe.status === 'unreachable_verified';
          case 'unverified_inconclusive':
            return lead.websiteProbe.status === 'unverified_inconclusive';
          case 'active_http':
            return lead.websiteProbe.status === 'active_http';
          case 'active_https':
            return lead.websiteProbe.status === 'active_https';
          case 'all':
          default:
            return true;
        }
      })
      .sort((a, b) => b.digitalScore.score - a.digitalScore.score);
  }, [
    leads,
    smartFilters,
    discardedPlaceIds,
    followupByPlaceId,
    showExcludedAndDiscarded,
    currentParams?.maxReviews,
    websiteFilter,
  ]);

  const paginatedLeads = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredLeads.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredLeads, currentPage]);

  const selectedLead = useMemo(
    () => leads.find((l) => l.placeId === selectedPlaceId) || null,
    [leads, selectedPlaceId]
  );

  const funnelMetrics = useMemo(
    () =>
      computeIndependentFunnelMetrics(leads, followups, {
        discardedPlaceIdsCount: discardedPlaceIds.size,
      }),
    [leads, followups, discardedPlaceIds.size]
  );

  const excludedCountInSession = useMemo(
    () =>
      leads.filter(
        (l) => l.exclusionMatch.excluded || discardedPlaceIds.has(l.placeId)
      ).length,
    [leads, discardedPlaceIds]
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {mapsQuotaBanner && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Clean 3-Zone Top Bar */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-8">
          <span className="text-lg font-bold tracking-tight text-purple-800 whitespace-nowrap shrink-0">
            Peru Lead Extractor Pro
          </span>

          <nav className="flex items-center gap-6 text-sm font-medium">
            <button
              type="button"
              onClick={() => setActiveTab('explorer')}
              className={`whitespace-nowrap shrink-0 pb-1 border-b-2 transition-colors ${
                activeTab === 'explorer'
                  ? 'border-purple-700 text-purple-800 font-semibold'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Explorador ({filteredLeads.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('crm')}
              className={`whitespace-nowrap shrink-0 pb-1 border-b-2 transition-colors ${
                activeTab === 'crm'
                  ? 'border-purple-700 text-purple-800 font-semibold'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Seguimiento ({temporaryQueue.length} temp · {followups.length} CRM)
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('exclusions')}
              className={`whitespace-nowrap shrink-0 pb-1 border-b-2 transition-colors ${
                activeTab === 'exclusions'
                  ? 'border-purple-700 text-purple-800 font-semibold'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Exclusiones ({exclusions.length})
            </button>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            {user ? (
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline text-xs text-slate-600 truncate max-w-[180px]">
                  {user.email}
                </span>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Salir
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleSignIn}
                className="px-4 py-2 text-xs font-semibold bg-purple-700 hover:bg-purple-800 text-white rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
              >
                <LogIn className="w-3.5 h-3.5" />
                Iniciar sesión Google
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {firebaseError && (
          <div className="bg-red-50 border border-red-200 text-red-900 rounded-xl px-4 py-3 text-xs flex items-center justify-between gap-4">
            <span>{firebaseError}</span>
            <button
              type="button"
              onClick={() => setFirebaseError(null)}
              className="underline font-medium shrink-0"
            >
              Cerrar
            </button>
          </div>
        )}

        <FunnelMetricsBar metrics={funnelMetrics} />

        {activeTab === 'explorer' && (
          <div className="space-y-6">
            <SearchForm
              onSearch={handleSearch}
              onSuggestSubzones={handleSuggestSubzones}
              isLoading={isLoading}
              isLoadingSubzones={isLoadingSubzones}
              subzones={subzones}
              subzoneRationale={subzoneRationale}
              subzoneError={subzoneError}
              quota={quota}
              websiteFilter={websiteFilter}
              onWebsiteFilterChange={(f) => {
                setWebsiteFilter(f);
                setCurrentPage(1);
              }}
            />

            <SmartFilterBar
              filters={smartFilters}
              onChange={(next) => {
                setSmartFilters(next);
                setCurrentPage(1);
              }}
              onReset={() => {
                setSmartFilters(DEFAULT_SMART_FILTERS);
                setWebsiteFilter('all');
                setCurrentPage(1);
              }}
              totalLoaded={leads.length}
              filteredCount={filteredLeads.length}
              isAnalyzing={isQualifying}
              onRunAutoQualifier={handleRunAutoQualifier}
            />

            {searchError && (
              <div className="bg-red-50 border border-red-200 text-red-900 rounded-xl p-4 text-sm">
                <div className="font-semibold">Error en la consulta</div>
                <p className="mt-1 text-xs">{searchError}</p>
              </div>
            )}

            {searchNotice && !searchError && (
              <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                <div className="text-slate-700 font-medium">{searchNotice}</div>
                <div className="flex flex-wrap items-center gap-3">
                  {excludedCountInSession > 0 && (
                    <label className="flex items-center gap-1.5 text-slate-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showExcludedAndDiscarded}
                        onChange={(e) => setShowExcludedAndDiscarded(e.target.checked)}
                      />
                      Mostrar excluidos/descartados ({excludedCountInSession})
                    </label>
                  )}
                  {paginatedLeads.some(
                    (l) => l.website && l.websiteProbe.provenance === 'google_absent'
                  ) && (
                    <button
                      type="button"
                      disabled={isBatchVerifying}
                      onClick={handleBatchVerifyVisible}
                      className="px-3 py-1.5 bg-purple-50 text-purple-800 border border-purple-200 rounded-lg font-medium hover:bg-purple-100 disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      {isBatchVerifying ? 'Verificando URLs...' : 'Verificar URLs visibles'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {leads.length === 0 && !isLoading && !searchError && (
              <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
                <h3 className="text-lg font-semibold text-slate-900">
                  Motor de Oportunidades WEBNEX SYSTEMS
                </h3>
                <p className="text-sm text-slate-600 mt-1 max-w-xl mx-auto">
                  Busca negocios reales en Perú usando Google Places API (New). Los resultados aparecen página por página sin cuotas ocultas, con separación estricta entre datos de Google Maps y verificación independiente.
                </p>
              </div>
            )}

            {leads.length > 0 && (
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
                <div className="xl:col-span-7 space-y-4">
                  <LeadTable
                    leads={paginatedLeads}
                    selectedPlaceId={selectedPlaceId}
                    verifyingPlaceId={verifyingPlaceId}
                    queuedPlaceIds={queuedPlaceIds}
                    checkedPlaceIds={checkedExplorerPlaceIds}
                    onToggleCheckPlace={handleToggleCheckPlace}
                    onToggleCheckAllVisible={() => {
                      const allVisibleChecked =
                        paginatedLeads.length > 0 &&
                        paginatedLeads.every((l) => checkedExplorerPlaceIds.has(l.placeId));
                      setCheckedExplorerPlaceIds((prev) => {
                        const next = new Set(prev);
                        if (allVisibleChecked) {
                          for (const l of paginatedLeads) next.delete(l.placeId);
                        } else {
                          for (const l of paginatedLeads) next.add(l.placeId);
                        }
                        return next;
                      });
                    }}
                    onAddToTemporaryQueue={(lead) => handleAddLeadsToTemporaryQueue([lead])}
                    onAddSelectedToTemporaryQueue={() => {
                      const picked = leads.filter((l) => checkedExplorerPlaceIds.has(l.placeId));
                      handleAddLeadsToTemporaryQueue(picked);
                      setCheckedExplorerPlaceIds(new Set());
                    }}
                    onSelectPlace={(lead) => setSelectedPlaceId(lead.placeId)}
                    onVerifyWebsite={handleVerifyWebsite}
                    onDiscardPlace={(lead) => handleDiscardPlace(lead)}
                  />

                  {showExcludedAndDiscarded && discards.length > 0 && (
                    <div className="text-xs text-slate-600 bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap gap-2 items-center">
                      <span>Descartados guardados ({discards.length}):</span>
                      {discards.slice(0, 6).map((d) => (
                        <button
                          key={d.placeId}
                          type="button"
                          onClick={() => handleRestoreDiscard(d.placeId)}
                          className="underline text-purple-700 hover:text-purple-900 font-mono-tabular"
                          title="Restaurar en sesión"
                        >
                          Restaurar {d.placeId.slice(0, 10)}…
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <Pagination
                      currentPage={currentPage}
                      totalItems={filteredLeads.length}
                      itemsPerPage={ITEMS_PER_PAGE}
                      onPageChange={(page) => {
                        setCurrentPage(page);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    />

                    {nextPageToken && (
                      <button
                        type="button"
                        disabled={isLoading}
                        onClick={handleLoadNextPage}
                        className="px-4 py-2.5 bg-white border border-purple-300 text-purple-800 hover:bg-purple-50 font-semibold text-xs rounded-xl inline-flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                      >
                        {isLoading ? 'Cargando página...' : 'Cargar siguiente página (Places)'}
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="xl:col-span-5 xl:sticky xl:top-20">
                  <PlacesMapView
                    leads={filteredLeads}
                    selectedPlaceId={selectedPlaceId}
                    onSelectPlace={(lead) => setSelectedPlaceId(lead.placeId)}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'crm' && (
          <FollowupCrmView
            isSignedIn={Boolean(user && user.emailVerified)}
            followups={followups}
            workspaceMode={workspaceMode}
            onChangeWorkspaceMode={setWorkspaceMode}
            productionCount={productionFollowups.length}
            exclusionPlaceIds={exclusionPlaceIds}
            hydrationCache={hydrationCache}
            placesQuotaBlock={placesQuotaBlock}
            quota={quota}
            onHydratePlaceIds={hydrateFollowupPlaceIds}
            temporaryQueue={temporaryQueue}
            subView={crmSubView}
            onChangeSubView={setCrmSubView}
            temporaryTtlHours={temporaryTtlHours}
            onChangeTemporaryTtlHours={handleChangeTemporaryTtlHours}
            isSyncingTemporaryQueue={isSyncingTemporaryQueue}
            temporaryRestorationNotice={temporaryRestorationNotice}
            onDismissTemporaryRestorationNotice={() => setTemporaryRestorationNotice(null)}
            onUpdateTemporaryEntry={handleUpdateTemporaryEntry}
            onRemoveTemporarySelected={handleRemoveTemporarySelected}
            onClearTemporaryQueue={handleClearTemporaryQueue}
            onPromoteTemporaryEntry={handlePromoteTemporaryEntryToCrm}
            onGoToExplorer={() => setActiveTab('explorer')}
            onDeleteFollowupsBatch={async (docIds, opts) => {
              if (!user || !user.emailVerified) {
                throw new Error('Inicia sesión con Google antes de eliminar registros en Firestore.');
              }
              return deleteFollowupsBatchWithProgress({
                uid: user.uid,
                workspaceMode,
                docIds,
                backupVerified: opts.backupVerified,
                onProgress: opts.onProgress,
              });
            }}
            onRecoverMissingFields={async (proposals) => {
              if (!user || !user.emailVerified) {
                throw new Error('Inicia sesión con Google antes de completar fichas en Firestore.');
              }
              return recoverMissingFollowupFieldsBatch(user.uid, proposals, workspaceMode);
            }}
            onFetchIntegrityBackup={async () => {
              if (!user || !user.emailVerified) {
                throw new Error('Inicia sesión con Google antes de verificar el respaldo en Firestore.');
              }
              return fetchFollowupsIntegritySnapshot(user.uid, workspaceMode);
            }}
            onSignIn={handleSignIn}
            onUpdateFollowup={async (id, updates, currentRecord): Promise<UpdateFollowupOutcome | void> => {
              if (!user) return;
              try {
                return await updateFollowupRecord(user.uid, id, updates, currentRecord, workspaceMode);
              } catch (err: any) {
                setFirebaseError(err?.message || formatFriendlyFirestoreError(err));
              }
            }}
            onCreateManualFollowup={async (payload) => {
              if (!user) return;
              const nowIso = new Date().toISOString();
              const phoneParsed = analyzePeruvianPhone(payload.independentPhone, payload.phoneStage);
              const formattedPhone = phoneParsed.formatted || payload.independentPhone;
              const resolvedWebsiteStatus = resolveIndependentWebsiteStatusForSave({
                independentWebsite: payload.independentWebsite,
                confirmedNoWebsite: payload.confirmedNoWebsite,
                verifiedProbe: null,
              });
              const manualProbe = {
                checkedUrl: payload.independentWebsite || null,
                finalUrl: null,
                status: resolvedWebsiteStatus,
                httpStatus: null,
                tlsValid: null,
                isSocialOnly: false,
                inconclusiveReason: null,
                summary: payload.confirmedNoWebsite
                  ? 'Confirmado manualmente sin web'
                  : payload.independentWebsite
                  ? 'URL registrada manualmente (pendiente de verificación HTTP)'
                  : 'Registrado manualmente en CRM',
                verifiedAt: nowIso,
                provenance: 'manual_user' as const,
              };
              const digitalEval = computeDigitalOpportunityScore(
                manualProbe,
                payload.confirmedNoWebsite,
                { category: payload.independentCategory }
              );
              const contactEval = computeContactabilityScore(
                phoneParsed,
                phoneParsed,
                payload.independentEmail,
                { legalBasis: payload.legalBasis }
              );
              const trustEval = computeInformationTrustScore({
                businessStatus: 'OPERATIONAL',
                independentBusinessName: payload.independentBusinessName,
                independentPhone: formattedPhone,
                independentAddress: payload.independentAddress,
                district: payload.district,
                independentWebsite: payload.independentWebsite,
                confirmedNoWebsite: payload.confirmedNoWebsite,
                independentCategory: payload.independentCategory,
                websiteProbe: manualProbe,
                verificationSourcesCount: 1,
                lastVerifiedAt: nowIso,
              });
              const completeness = evaluateFollowupCompleteness({
                independentBusinessName: payload.independentBusinessName,
                independentPhone: formattedPhone,
                independentAddress: payload.independentAddress,
                district: payload.district,
                independentWebsite: payload.independentWebsite,
                confirmedNoWebsite: payload.confirmedNoWebsite,
                independentEmail: payload.independentEmail,
                independentCategory: payload.independentCategory,
              });
              const sources: string[] = [
                encodeVerificationProvenanceEntry({
                  field: 'registro',
                  source: 'user_manual_entry',
                  evidence: payload.independentBusinessName,
                  verifiedAt: nowIso,
                }),
              ];

              await createFollowupRecord(
                user.uid,
                {
                  placeId: `manual_${Date.now()}`,
                  sourceKind: 'independent_manual',
                  independentBusinessName: payload.independentBusinessName,
                  district: payload.district,
                  independentAddress: payload.independentAddress,
                  independentWebsite: payload.independentWebsite,
                  independentCategory: payload.independentCategory,
                  confirmedNoWebsite: payload.confirmedNoWebsite,
                  independentWebsiteStatus: resolvedWebsiteStatus,
                  independentPhone: formattedPhone,
                  independentPhoneType: resolveIndependentPhoneType(formattedPhone),
                  phoneStage: payload.phoneStage,
                  independentEmail: payload.independentEmail,
                  independentDigitalScore: digitalEval.score,
                  independentContactScore: contactEval.score,
                  independentTrustScore: trustEval.score,
                  completenessStatus: completeness.status,
                  stage: 'PENDIENTE DE VERIFICACIÓN',
                  legalBasis: payload.legalBasis,
                  qualificationTier: '',
                  aiSummary: '',
                  notes: payload.notes,
                  verificationSummary: 'Registro independiente creado manualmente en Seguimiento.',
                  lastVerifiedAt: nowIso,
                  verificationSources: sources,
                },
                workspaceMode
              );
            }}
          />
        )}

        {activeTab === 'exclusions' && (
          <ExclusionManagerView
            isSignedIn={Boolean(user && user.emailVerified)}
            userEmail={user?.email || ''}
            exclusions={exclusions}
            exclusionKeys={exclusionKeys}
            onSignIn={handleSignIn}
            onVerifyFirestoreAccess={async () => {
              if (!user) {
                throw new Error('Inicia sesión con Google antes de verificar Firestore.');
              }
              return verifyUserFirestoreReadWrite(user.uid);
            }}
            onImportBatch={async (candidates, sourceLabel, onProgress) => {
              if (!user) return 0;
              return batchImportExclusions(user.uid, candidates, sourceLabel, onProgress);
            }}
            onDeleteExclusion={async (id) => {
              if (!user) return;
              try {
                await removeExclusionEntry(user.uid, id);
              } catch (err) {
                setFirebaseError(formatFriendlyFirestoreError(err));
              }
            }}
          />
        )}
      </main>

      <PlaceReviewDrawer
        lead={selectedLead}
        searchCategory={currentParams?.businessType || ''}
        searchDistrict={currentParams?.location || ''}
        isSignedIn={Boolean(user && user.emailVerified)}
        verifyingPlaceId={verifyingPlaceId}
        onClose={() => setSelectedPlaceId(null)}
        onRunWebsiteCheck={handleVerifyWebsite}
        onUpdateIndependentFields={handleUpdateIndependentFields}
        onPromoteToFollowup={handlePromoteToFollowup}
        onDiscardPlace={handleDiscardPlace}
      />

      <QualificationPreviewModal
        isOpen={qualifierOpen}
        isAnalyzing={isQualifying}
        progressLabel={qualifierProgress}
        geminiWarning={qualifierGeminiWarning}
        leads={leads}
        results={qualificationResults}
        summary={qualificationSummary}
        searchCategory={currentParams?.businessType || ''}
        searchDistrict={currentParams?.location || ''}
        isSignedIn={Boolean(user && user.emailVerified)}
        isSaving={isTransferringPreselected}
        workspaceMode={workspaceMode}
        onChangeWorkspaceMode={setWorkspaceMode}
        onAddSelectedToTemporaryQueue={(placeIds) => {
          const picked = leads.filter((l) => placeIds.includes(l.placeId));
          handleAddLeadsToTemporaryQueue(picked);
          setActiveTab('crm');
        }}
        onClose={() => setQualifierOpen(false)}
        onConfirmTransfer={handleConfirmTransferPreselected}
      />
    </div>
  );
};

export default App;
