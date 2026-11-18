import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { User } from 'firebase/auth';
import { ChevronRight, LogIn, LogOut, ShieldCheck } from 'lucide-react';
import { SearchForm } from './components/SearchForm';
import { LeadTable } from './components/LeadTable';
import { Pagination } from './components/Pagination';
import { FunnelMetricsBar } from './components/FunnelMetricsBar';
import { PlacesMapView } from './components/PlacesMapView';
import { PlaceReviewDrawer } from './components/PlaceReviewDrawer';
import { FollowupCrmView } from './components/FollowupCrmView';
import { ExclusionManagerView } from './components/ExclusionManagerView';
import { SmartFilterBar } from './components/SmartFilterBar';
import { QualificationPreviewModal } from './components/QualificationPreviewModal';
import {
  analyzeLeadsComplementarily,
  buildBusinessLeadFromPlace,
  fetchQuotaStatus,
  fetchSubzoneSuggestions,
  searchPlacesPage,
  verifyWebsiteUrl,
} from './services/geminiService';
import {
  batchImportExclusions,
  createBatchPreselectedFollowups,
  createFollowupRecord,
  formatFriendlyFirestoreError,
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
  verifyUserFirestoreReadWrite,
} from './services/firebaseService';
import {
  BusinessLead,
  DEFAULT_SMART_FILTERS,
  DiscardRecord,
  ExclusionRecord,
  FollowupLeadRecord,
  FollowupSourceKind,
  GeminiComplementaryAnalysis,
  GooglePlaceRaw,
  LeadQualificationResult,
  PhoneVerificationStage,
  QualifierBatchSummary,
  QuotaStatus,
  SearchParams,
  SmartFilterState,
  WebsiteFilterOption,
} from './types';
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
  deduplicatePlacesById,
} from './utils/scoring';

type WorkspaceTab = 'explorer' | 'crm' | 'exclusions';

const ITEMS_PER_PAGE = 25;

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('explorer');
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [firebaseError, setFirebaseError] = useState<string | null>(null);
  const [mapsQuotaBanner, setMapsQuotaBanner] = useState(false);

  // Persistent user collections from Firestore (empty until authenticated)
  const [exclusions, setExclusions] = useState<ExclusionRecord[]>([]);
  const [discards, setDiscards] = useState<DiscardRecord[]>([]);
  const [followups, setFollowups] = useState<FollowupLeadRecord[]>([]);
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

  useEffect(() => {
    const onQuotaExceeded = () => setMapsQuotaBanner(true);
    window.addEventListener('gmp-quota-exceeded', onQuotaExceeded);
    testFirestoreConnection();
    fetchQuotaStatus().then((q) => {
      if (q) setQuota(q);
    });

    const unsubAuth = subscribeToAuth((u) => {
      setUser(u);
      setAuthReady(true);
    });

    return () => {
      window.removeEventListener('gmp-quota-exceeded', onQuotaExceeded);
      unsubAuth();
    };
  }, []);

  useEffect(() => {
    if (!authReady || !user || !user.emailVerified) {
      setExclusions([]);
      setDiscards([]);
      setFollowups([]);
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
    const unsubFoll = subscribeUserFollowups(
      user.uid,
      (items) => setFollowups(items),
      (msg) => setFirebaseError(msg)
    );

    return () => {
      unsubExcl();
      unsubDisc();
      unsubFoll();
    };
  }, [authReady, user]);

  const exclusionKeys = useMemo(() => buildExclusionKeySet(exclusions), [exclusions]);
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

  const handleSearch = async (params: SearchParams) => {
    setIsLoading(true);
    setSearchError(null);
    setSearchNotice('');
    setCurrentParams(params);
    setCurrentPage(1);
    setSelectedPlaceId(null);

    try {
      const response = await searchPlacesPage(params);
      setQuota(response.quota);
      const uniqueRaw = deduplicatePlacesById([], response.places);
      setRawPlaces(uniqueRaw);

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
      if (err?.quota) setQuota(err.quota);
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
      setQuota(response.quota);
      const mergedRaw = deduplicatePlacesById(rawPlaces, response.places);
      const newOnly = mergedRaw.slice(rawPlaces.length);
      setRawPlaces(mergedRaw);

      const builtNew = newOnly.map((r) =>
        buildBusinessLeadFromPlace(r, currentParams.businessType, exclusionKeys)
      );
      setLeads((prev) => [...prev, ...builtNew]);
      setNextPageToken(response.nextPageToken);
      setSearchNotice(
        `Página adicional cargada: +${builtNew.length} negocios únicos (total ${mergedRaw.length}).`
      );
    } catch (err: any) {
      if (err?.quota) setQuota(err.quota);
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

  const handleVerifyWebsite = useCallback(async (lead: BusinessLead) => {
    if (!lead.website) return;
    setVerifyingPlaceId(lead.placeId);
    try {
      const probe = await verifyWebsiteUrl(lead.website);
      setLeads((prev) =>
        prev.map((item) => {
          if (item.placeId !== lead.placeId) return item;
          const nextProbe = item.confirmedNoWebsite
            ? { ...item.websiteProbe, status: 'confirmed_none' as const }
            : probe;
          return {
            ...item,
            websiteProbe: nextProbe,
            digitalScore: computeDigitalOpportunityScore(nextProbe, item.confirmedNoWebsite),
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

        return {
          ...lead,
          confirmedNoWebsite: patch.confirmedNoWebsite,
          independentPhone: independentPhoneParsed.formatted || patch.independentPhone.trim(),
          independentEmail: patch.independentEmail.trim(),
          independentWebsiteNote: patch.independentWebsiteNote,
          phoneAnalysis: nextGooglePhone,
          websiteProbe: nextProbe,
          digitalScore: computeDigitalOpportunityScore(nextProbe, patch.confirmedNoWebsite),
          contactabilityScore: computeContactabilityScore(
            nextGooglePhone,
            independentPhoneParsed,
            patch.independentEmail
          ),
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
    independentData: {
      sourceKind: FollowupSourceKind;
      independentBusinessName: string;
      district: string;
      confirmedNoWebsite: boolean;
      independentPhone: string;
      phoneStage: PhoneVerificationStage;
      independentEmail: string;
      legalBasis: string;
      notes: string;
    }
  ) => {
    if (!user || !user.emailVerified) {
      throw new Error('Inicia sesión con Google para guardar seguimientos en Firestore.');
    }

    const phoneParsed = analyzePeruvianPhone(
      independentData.independentPhone,
      independentData.phoneStage
    );
    const nextProbe = independentData.confirmedNoWebsite
      ? { ...lead.websiteProbe, status: 'confirmed_none' as const }
      : lead.websiteProbe;

    const digitalEval = computeDigitalOpportunityScore(
      nextProbe,
      independentData.confirmedNoWebsite
    );
    const contactEval = computeContactabilityScore(
      lead.phoneAnalysis,
      phoneParsed,
      independentData.independentEmail
    );

    const hasLegalAuthorization = (independentData.legalBasis || '').trim().length >= 8;

    await createFollowupRecord(user.uid, {
      placeId: lead.placeId,
      sourceKind: independentData.sourceKind,
      independentBusinessName: independentData.independentBusinessName,
      district: independentData.district,
      confirmedNoWebsite: independentData.confirmedNoWebsite,
      independentWebsiteStatus: nextProbe.status,
      independentPhone: independentData.independentPhone,
      phoneStage: independentData.phoneStage,
      independentEmail: independentData.independentEmail,
      independentDigitalScore: digitalEval.score,
      independentContactScore: contactEval.score,
      stage: hasLegalAuthorization ? 'CONTACTO AUTORIZADO' : 'PENDIENTE DE VERIFICACIÓN',
      legalBasis: independentData.legalBasis,
      qualificationTier: '',
      aiSummary: '',
      notes: independentData.notes,
    });
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
          digitalScore: computeDigitalOpportunityScore(probe, item.confirmedNoWebsite),
        };
      });
      setLeads(updatedLeads);

      // 2. Calificación determinística sobre TODOS los resultados cargados
      setQualifierProgress('Ejecutando clasificación determinística WEBNEX...');
      const deterministic = qualifyLoadedLeadsBatch(updatedLeads, {
        discardedPlaceIds,
        existingFollowups: followups,
      });

      // 3. Gemini complementario SOLO sobre señales permitidas (web oficial o notas propias) para casos donde aporta valor
      const aiCandidates = deterministic.results
        .filter((res) => res.tier === 'PRIORIDAD ALTA' || res.tier === 'REVISIÓN PENDIENTE')
        .map((res) => {
          const lead = updatedLeads.find((l) => l.placeId === res.placeId);
          return { res, lead };
        })
        .filter(
          (pair): pair is { res: LeadQualificationResult; lead: BusinessLead } =>
            Boolean(pair.lead) &&
            (Boolean(pair.lead.website && pair.lead.websiteProbe.status !== 'social_only') ||
              Boolean(pair.lead.independentWebsiteNote.trim()))
        )
        .slice(0, 8);

      const geminiMap = new Map<string, GeminiComplementaryAnalysis>();
      if (aiCandidates.length > 0) {
        setQualifierProgress(
          `Analizando ${aiCandidates.length} sitios/notas independientes con Gemini (sin contenido Maps)...`
        );
        const aiRes = await analyzeLeadsComplementarily(
          aiCandidates.map(({ lead }) => ({
            placeId: lead.placeId,
            category: lead.category,
            websiteStatus: lead.websiteProbe.status,
            officialWebsiteUrl: lead.website,
            userNotes: lead.independentWebsiteNote,
          }))
        );
        if (aiRes.quota) setQuota(aiRes.quota);
        if (aiRes.warning) setQualifierGeminiWarning(aiRes.warning);
        for (const analysis of aiRes.analyses) {
          geminiMap.set(analysis.placeId, analysis);
        }
      }

      const finalEval = qualifyLoadedLeadsBatch(updatedLeads, {
        discardedPlaceIds,
        existingFollowups: followups,
        geminiAnalysesByPlaceId: geminiMap,
      });

      setQualificationResults(finalEval.results);
      setQualificationSummary(finalEval.summary);
    } finally {
      setIsQualifying(false);
    }
  };

  const handleConfirmTransferPreselected = async (selectedResults: LeadQualificationResult[]) => {
    if (!user || !user.emailVerified) {
      setFirebaseError('Inicia sesión con Google para guardar preselecciones en Firestore.');
      return;
    }

    setIsTransferringPreselected(true);
    try {
      const existingPlaceIds = new Set(followups.map((f) => f.placeId));
      const payloadItems = selectedResults.map((res) => {
        const lead = leads.find((l) => l.placeId === res.placeId);
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

        return {
          placeId: res.placeId,
          confirmedNoWebsite: Boolean(lead?.confirmedNoWebsite),
          independentWebsiteStatus: lead?.websiteProbe.status || 'unregistered',
          phoneStage: lead?.phoneAnalysis.stage || 'none',
          independentDigitalScore: res.digitalScore,
          independentContactScore: res.contactabilityScore,
          stage:
            res.tier === 'PRIORIDAD ALTA'
              ? ('PRESELECCIONADO' as const)
              : ('PENDIENTE DE VERIFICACIÓN' as const),
          qualificationTier: res.tier,
          aiSummary: aiText,
          notes: res.reasons.join(' '),
        };
      });

      const outcome = await createBatchPreselectedFollowups(
        user.uid,
        payloadItems,
        existingPlaceIds
      );
      setQualifierOpen(false);
      setSearchNotice(
        `Preselección transferida a Seguimiento: ${outcome.created} nuevos registros guardados por Place ID (${outcome.skippedDuplicates} ya existían en CRM y no se duplicaron).`
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
              Seguimiento ({followups.length})
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
            onSignIn={handleSignIn}
            onUpdateFollowup={async (id, updates, currentRecord) => {
              if (!user) return;
              try {
                await updateFollowupRecord(user.uid, id, updates, currentRecord);
              } catch (err: any) {
                setFirebaseError(err?.message || formatFriendlyFirestoreError(err));
              }
            }}
            onCreateManualFollowup={async (payload) => {
              if (!user) return;
              const phoneParsed = analyzePeruvianPhone(payload.independentPhone, payload.phoneStage);
              const digitalEval = computeDigitalOpportunityScore(
                {
                  checkedUrl: null,
                  finalUrl: null,
                  status: payload.confirmedNoWebsite ? 'confirmed_none' : 'unregistered',
                  httpStatus: null,
                  tlsValid: null,
                  isSocialOnly: false,
                  inconclusiveReason: null,
                  summary: payload.confirmedNoWebsite
                    ? 'Confirmado manualmente sin web'
                    : 'Sin web registrada',
                  verifiedAt: new Date().toISOString(),
                  provenance: 'manual_user',
                },
                payload.confirmedNoWebsite
              );
              const contactEval = computeContactabilityScore(
                phoneParsed,
                phoneParsed,
                payload.independentEmail
              );
              await createFollowupRecord(user.uid, {
                placeId: `manual_${Date.now()}`,
                sourceKind: 'independent_manual',
                independentBusinessName: payload.independentBusinessName,
                district: payload.district,
                confirmedNoWebsite: payload.confirmedNoWebsite,
                independentWebsiteStatus: payload.confirmedNoWebsite ? 'confirmed_none' : 'unregistered',
                independentPhone: phoneParsed.formatted || payload.independentPhone,
                phoneStage: payload.phoneStage,
                independentEmail: payload.independentEmail,
                independentDigitalScore: digitalEval.score,
                independentContactScore: contactEval.score,
                stage: 'PENDIENTE DE VERIFICACIÓN',
                legalBasis: payload.legalBasis,
                qualificationTier: '',
                aiSummary: '',
                notes: payload.notes,
              });
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
        isSignedIn={Boolean(user && user.emailVerified)}
        isSaving={isTransferringPreselected}
        onClose={() => setQualifierOpen(false)}
        onConfirmTransfer={handleConfirmTransferPreselected}
      />
    </div>
  );
};

export default App;
