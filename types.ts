export type WebsiteVerificationStatus =
  | 'unregistered'
  | 'confirmed_none'
  | 'active_https'
  | 'active_http'
  | 'social_only'
  | 'unreachable_verified'
  | 'unverified_inconclusive'
  | 'invalid_url';

export type PhoneVerificationStage =
  | 'none'
  | 'registered_invalid'
  | 'registered_valid_format'
  | 'independently_corroborated'
  | 'contact_reached';

export type PhoneLineType = 'mobile' | 'landline_lima' | 'landline_regional' | 'invalid' | 'none';

export interface PeruvianPhoneAnalysis {
  raw: string;
  e164: string | null;
  formatted: string | null;
  lineType: PhoneLineType;
  isValidFormat: boolean;
  stage: PhoneVerificationStage;
  note: string;
}

export interface WebsiteProbeResult {
  checkedUrl: string | null;
  finalUrl: string | null;
  status: WebsiteVerificationStatus;
  httpStatus: number | null;
  tlsValid: boolean | null;
  isSocialOnly: boolean;
  inconclusiveReason: string | null;
  summary: string;
  verifiedAt: string;
  provenance: 'google_absent' | 'independent_http' | 'manual_user';
}

export interface ScoreBreakdownItem {
  label: string;
  points: number;
  provenance: 'independent_verified' | 'manual_user' | 'google_reference';
}

export interface DigitalOpportunityEvaluation {
  score: number;
  label: string;
  isIndependentlyVerified: boolean;
  reasons: string[];
  breakdown: ScoreBreakdownItem[];
}

export interface ContactabilityEvaluation {
  score: number;
  label: string;
  isIndependentlyCorroborated: boolean;
  reasons: string[];
  breakdown: ScoreBreakdownItem[];
}

export interface InformationTrustEvaluation {
  score: number;
  label: string;
  isOperational: boolean;
  hasContradictions: boolean;
  contradictions: string[];
  missingCoreFields: string[];
  reasons: string[];
  breakdown: ScoreBreakdownItem[];
}

export interface GooglePlaceRaw {
  placeId: string;
  displayName: string;
  formattedAddress: string;
  location: { lat: number; lng: number } | null;
  nationalPhoneNumber: string | null;
  internationalPhoneNumber: string | null;
  websiteUri: string | null;
  googleMapsUri: string;
  rating: number | null;
  userRatingCount: number | null;
  businessStatus: string | null;
  primaryTypeDisplayName: string | null;
}

export interface HydratedPlaceDetails {
  placeId: string;
  displayName: string;
  formattedAddress: string;
  nationalPhoneNumber: string | null;
  internationalPhoneNumber: string | null;
  websiteUri: string | null;
  googleMapsUri: string;
  businessStatus: string | null;
}

export type PlaceHydrationStatus =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'quota_exceeded'
  | 'local_quota_exceeded'
  | 'transient_error'
  | 'unavailable';

export interface PlaceHydrationEntry {
  placeId: string;
  status: PlaceHydrationStatus;
  details: HydratedPlaceDetails | null;
  errorCode?: string;
  errorMessage?: string;
  retryCount: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface PlaceDetailsBatchItemResult {
  status: 'loaded' | 'unavailable' | 'quota_exceeded' | 'local_quota_exceeded' | 'transient_error';
  details?: HydratedPlaceDetails;
  code?: string;
  message?: string;
}

export type PlacesQuotaBlockSource = 'none' | 'google_resource_exhausted' | 'local_preventive_limit';

export interface PlacesQuotaBlockState {
  blocked: boolean;
  source: PlacesQuotaBlockSource;
  message: string | null;
}

export interface FollowupIntegrityReport {
  totalDocuments: number;
  uniqueDocIds: number;
  uniquePlaceIds: number;
  records: FollowupLeadRecord[];
  backedUpAt: string;
}

export interface BusinessLead {
  // Primary deduplication key (Google Place ID)
  placeId: string;
  id: string;
  // Google Maps session-only display fields (never persisted in bulk or exported)
  name: string;
  rating: string;
  ratingNumeric: number | null;
  reviews: string;
  reviewsNumeric: number | null;
  address: string;
  phone: string;
  mapsUrl: string;
  category: string;
  website: string;
  location: { lat: number; lng: number } | null;
  businessStatus: string | null;
  primaryTypeLabel: string | null;
  // Independent validation & separated scores
  phoneAnalysis: PeruvianPhoneAnalysis;
  websiteProbe: WebsiteProbeResult;
  confirmedNoWebsite: boolean;
  independentPhone: string;
  independentEmail: string;
  independentWebsiteNote: string;
  digitalScore: DigitalOpportunityEvaluation;
  contactabilityScore: ContactabilityEvaluation;
  trustScore: InformationTrustEvaluation;
  exclusionMatch: {
    excluded: boolean;
    matchedRule: string | null;
  };
}

export type WebsiteFilterOption =
  | 'all'
  | 'no_website_any'
  | 'unregistered'
  | 'confirmed_none'
  | 'social_only'
  | 'unreachable_verified'
  | 'unverified_inconclusive'
  | 'active_http'
  | 'active_https';

export interface SmartFilterState {
  mobileOnly: boolean;
  excludeLandlines: boolean;
  mobileAndNoWebsite: boolean;
  socialOnly: boolean;
  corroboratedWebFailure: boolean;
  pendingVerification: boolean;
  excludeClientsDiscardsDuplicates: boolean;
}

export const DEFAULT_SMART_FILTERS: SmartFilterState = {
  mobileOnly: false,
  excludeLandlines: false,
  mobileAndNoWebsite: false,
  socialOnly: false,
  corroboratedWebFailure: false,
  pendingVerification: false,
  excludeClientsDiscardsDuplicates: true,
};

export interface SearchParams {
  businessType: string;
  location: string;
  maxReviews: number;
  websiteFilter: WebsiteFilterOption;
  subzone?: string;
}

export interface ScrapingState {
  isLoading: boolean;
  error: string | null;
  leads: BusinessLead[];
  currentPage: number;
  itemsPerPage: number;
}

export type FollowupStage =
  | 'PRESELECCIONADO'
  | 'PENDIENTE DE VERIFICACIÓN'
  | 'CONTACTO AUTORIZADO'
  | 'CONTACTADO'
  | 'RESPONDIÓ'
  | 'INTERESADO'
  | 'COTIZACIÓN'
  | 'CLIENTE'
  | 'DESCARTADO';

export const FOLLOWUP_STAGES: FollowupStage[] = [
  'PRESELECCIONADO',
  'PENDIENTE DE VERIFICACIÓN',
  'CONTACTO AUTORIZADO',
  'CONTACTADO',
  'RESPONDIÓ',
  'INTERESADO',
  'COTIZACIÓN',
  'CLIENTE',
  'DESCARTADO',
];

export const AUTHORIZED_OUTREACH_STAGES: ReadonlySet<FollowupStage> = new Set([
  'CONTACTO AUTORIZADO',
  'CONTACTADO',
  'RESPONDIÓ',
  'INTERESADO',
  'COTIZACIÓN',
  'CLIENTE',
]);

export type FollowupSourceKind = 'places_preselection' | 'independent_manual';

export type QualificationTier = 'PRIORIDAD ALTA' | 'REVISIÓN PENDIENTE' | 'NO ELEGIBLE';

export type CrmWorkspaceMode = 'production' | 'sandbox';

export type CommercialOutcomeType =
  | 'none'
  | 'datos_incorrectos'
  | 'numero_inexistente'
  | 'sin_respuesta'
  | 'no_corresponde'
  | 'no_interesado'
  | 'respondio'
  | 'interesado'
  | 'cotizacion_enviada'
  | 'venta_confirmada'
  | 'no_volver_a_contactar';

export interface CommercialOutcomeOption {
  value: CommercialOutcomeType;
  label: string;
  isNegativeContactSignal: boolean;
  isPositiveOutcome: boolean;
}

export const COMMERCIAL_OUTCOME_OPTIONS: CommercialOutcomeOption[] = [
  { value: 'none', label: 'Sin resultado registrado', isNegativeContactSignal: false, isPositiveOutcome: false },
  { value: 'datos_incorrectos', label: 'Datos incorrectos', isNegativeContactSignal: true, isPositiveOutcome: false },
  { value: 'numero_inexistente', label: 'Número inexistente', isNegativeContactSignal: true, isPositiveOutcome: false },
  { value: 'sin_respuesta', label: 'Número sin respuesta', isNegativeContactSignal: false, isPositiveOutcome: false },
  { value: 'no_corresponde', label: 'No corresponde al negocio', isNegativeContactSignal: true, isPositiveOutcome: false },
  { value: 'no_interesado', label: 'No interesado', isNegativeContactSignal: false, isPositiveOutcome: false },
  { value: 'respondio', label: 'Respondió', isNegativeContactSignal: false, isPositiveOutcome: true },
  { value: 'interesado', label: 'Interesado', isNegativeContactSignal: false, isPositiveOutcome: true },
  { value: 'cotizacion_enviada', label: 'Cotización enviada', isNegativeContactSignal: false, isPositiveOutcome: true },
  { value: 'venta_confirmada', label: 'Venta confirmada', isNegativeContactSignal: false, isPositiveOutcome: true },
  { value: 'no_volver_a_contactar', label: 'No volver a contactar', isNegativeContactSignal: true, isPositiveOutcome: false },
];

export interface OutcomeCalibrationStats {
  reviewedCount: number;
  corroboratedCount: number;
  legallyAuthorizedCount: number;
  reachedCount: number;
  effectiveResponsesCount: number;
  interestedCount: number;
  quotationsCount: number;
  confirmedSalesCount: number;
  negativeOutcomesCount: number;
  sampleSizeSufficient: boolean;
  minimumSampleThreshold: number;
  insights: string[];
}

export interface GeminiComplementaryAnalysis {
  placeId: string;
  digitalNeeds: string[];
  recommendedWebnexServices: string[];
  commercialRelevance: string;
  missingInformation: string[];
  manualVerificationSteps: string[];
  contradictions?: string[];
  observedEvidence?: string[];
  analyzedSourceNote: string;
}

export interface LeadQualificationResult {
  placeId: string;
  tier: QualificationTier;
  digitalScore: number;
  contactabilityScore: number;
  trustScore: number;
  combinedPriorityScore: number;
  isFichaCompleta: boolean;
  contradictions: string[];
  reasons: string[];
  missingInformation: string[];
  isLandlineOnly: boolean;
  hasMobile: boolean;
  excludedReason: string | null;
  alreadyInFollowup: boolean;
  geminiAnalysis: GeminiComplementaryAnalysis | null;
}

export interface QualifierBatchSummary {
  totalEvaluated: number;
  highPriorityCount: number;
  pendingReviewCount: number;
  notEligibleCount: number;
  discardedLandlineCount: number;
  noMobileCount: number;
  duplicatesAndExcludedCount: number;
  alreadyInCrmSkippedCount: number;
}

export type IndependentFieldSource =
  | 'official_website_jsonld'
  | 'official_website_html'
  | 'authorized_public_source'
  | 'meta_graph_api'
  | 'user_manual_entry'
  | 'phone_call_verified'
  | 'user_search_context'
  | 'ssrf_http_probe'
  | 'none';

export type FieldClassificationStatus =
  | 'corroborated_persistable'
  | 'maps_session_only'
  | 'contradictory'
  | 'not_found';

export type ResearchableFieldKey =
  | 'businessName'
  | 'phone'
  | 'address'
  | 'district'
  | 'website'
  | 'email'
  | 'category';

export interface FieldResearchClassification {
  field: ResearchableFieldKey;
  label: string;
  status: FieldClassificationStatus;
  independentValue: string | null;
  mapsSessionValue: string | null;
  source: IndependentFieldSource;
  sourceLabel: string;
  evidenceUrl: string | null;
  reason: string;
}

export interface IdentityMatchSignals {
  overallConfidence: 'high' | 'medium' | 'low' | 'conflict' | 'unconfirmed' | 'none';
  identityStatusLabel?:
    | 'IDENTIDAD CONFIRMADA'
    | 'COINCIDENCIA PARCIAL'
    | 'CONFLICTO DE IDENTIDAD'
    | 'IDENTIDAD NO CONFIRMADA';
  matchedSignals: Array<'name' | 'district' | 'address' | 'phone' | 'category'>;
  conflictingSignals: Array<'name' | 'district' | 'address' | 'phone' | 'category'>;
  nameSimilarity: number;
  districtMatches: boolean | null;
  addressMatches: boolean | null;
  phoneMatches: boolean | null;
  categoryCompatible?: boolean | null;
  rejectionReasons?: string[];
  summary: string;
}

export interface SourceConsultationAttempt {
  sourceId:
    | 'official_website'
    | 'meta_social'
    | 'datosperu_ruc'
    | 'directory_reference'
    | 'user_evidence_gemini';
  sourceName: string;
  status: 'found' | 'not_found' | 'blocked_or_restricted' | 'skipped' | 'error';
  httpStatus: number | null;
  checkedUrl: string | null;
  retentionPermitted: boolean;
  costNote: string;
  detail: string;
}

export interface MissingDataResearchItemInput {
  placeId: string;
  officialWebsiteUrl?: string | null;
  socialOrDirectoryUrl?: string | null;
  userProvidedEvidenceText?: string;
  notesText?: string;
  searchCategory?: string;
  searchDistrict?: string;
  allowGeminiEvidenceAnalysis?: boolean;
  sessionMapsRef?: {
    name?: string;
    address?: string;
    phone?: string;
    website?: string;
    district?: string;
  };
}

export interface MissingDataResearchResult {
  placeId: string;
  needsIndependentData: boolean;
  canPersistCompleteCard: boolean;
  hasContradictions: boolean;
  recommendedQueue: 'complete_ready' | 'research_queue';
  missingPersistableFields: string[];
  contradictionAlerts: string[];
  identityMatch: IdentityMatchSignals;
  fieldClassifications: Record<ResearchableFieldKey, FieldResearchClassification>;
  sourceAttempts: SourceConsultationAttempt[];
  corroboration: IndependentCorroborationResult;
  manualReviewLinks: Array<{ label: string; url: string; note: string }>;
  usedGemini: boolean;
  summary: string;
  researchedAt: string;
}

export type GooglePlacesStoragePolicy =
  | 'PERMITTED_PERMANENT_ID'
  | 'SESSION_MEMORY_ONLY'
  | 'PROHIBITED_PERMANENT_STORAGE'
  | 'PERMITTED_INDEPENDENT_SOURCE';

export interface CorroboratedFieldCandidate<T = string> {
  value: T;
  source: IndependentFieldSource;
  evidenceUrl: string | null;
  verifiedAt: string;
  confidence: 'high' | 'medium';
}

export interface IndependentCorroborationResult {
  placeId: string;
  checkedUrls: string[];
  websiteStatus: WebsiteVerificationStatus;
  completeness: 'complete' | 'partial' | 'insufficient';
  summary: string;
  candidates: {
    businessName: CorroboratedFieldCandidate<string> | null;
    phone: CorroboratedFieldCandidate<string> | null;
    phoneType: CorroboratedFieldCandidate<PhoneLineType> | null;
    address: CorroboratedFieldCandidate<string> | null;
    district: CorroboratedFieldCandidate<string> | null;
    website: CorroboratedFieldCandidate<string> | null;
    email: CorroboratedFieldCandidate<string> | null;
    category: CorroboratedFieldCandidate<string> | null;
  };
}

export interface FollowupCompletenessInfo {
  status: 'complete' | 'partial' | 'place_id_only';
  isFichaIncompleta: boolean;
  label: string;
  presentFields: string[];
  missingFields: string[];
  percent: number;
}

export interface FollowupLeadRecord {
  id: string;
  ownerUid: string;
  placeId: string;
  sourceKind: FollowupSourceKind;
  independentBusinessName: string;
  district: string;
  confirmedNoWebsite: boolean;
  independentWebsiteStatus: WebsiteVerificationStatus;
  independentPhone: string;
  phoneStage: PhoneVerificationStage;
  independentEmail: string;
  independentDigitalScore: number;
  independentContactScore: number;
  independentTrustScore?: number;
  completenessStatus?: 'complete' | 'partial' | 'place_id_only';
  stage: FollowupStage;
  legalBasis: string;
  qualificationTier: QualificationTier | '';
  aiSummary: string;
  notes: string;
  // Campos comerciales, resultados y procedencia independientes opcionales (retrocompatibles con los 52 documentos existentes)
  independentAddress?: string;
  independentWebsite?: string;
  independentCategory?: string;
  independentPhoneType?: PhoneLineType;
  verificationSummary?: string;
  lastVerifiedAt?: string;
  verificationSources?: string[];
  commercialOutcome?: CommercialOutcomeType;
  outcomeSource?: string;
  outcomeContext?: string;
  outcomeRecordedAt?: string;
  outcomeHistory?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExclusionRecord {
  id: string;
  ownerUid: string;
  type: 'phone' | 'domain' | 'placeId';
  normalizedValue: string;
  rawSample: string;
  sourceLabel: string;
  createdAt: string;
}

export interface DiscardRecord {
  placeId: string;
  ownerUid: string;
  reason: string;
  discardedAt: string;
}

export interface QuotaStatus {
  dateLima: string;
  placesUsed: number;
  placesLimit: number;
  placesFailed?: number;
  googleQuotaBlocked?: boolean;
  googleQuotaBlockedMessage?: string | null;
  geminiUsed: number;
  geminiLimit: number;
  note: string;
}

export interface IndependentFunnelMetrics {
  uniqueBusinessesFound: number;
  discardedLandlineCount: number;
  noMobileCount: number;
  corroboratedRecords: number;
  verifiableDigitalOpportunities: number;
  pendingCorroborationCount: number;
  preselectedCount: number;
  duplicatesAndExcludedCount: number;
  authorizedContactsCount: number;
  authorizedContactsMade: number;
  responsesReceived: number;
  qualifiedOpportunities: number;
  confirmedSales: number;
}

export type TemporaryQueueOutcome =
  | 'pendiente'
  | 'contacto_no_autorizado'
  | 'numero_incorrecto'
  | 'no_responde'
  | 'contacto_alcanzado'
  | 'no_interesado'
  | 'interesado'
  | 'cotizacion'
  | 'cliente'
  | 'descartado';

export interface TemporaryQueueOutcomeMeta {
  value: TemporaryQueueOutcome;
  label: string;
  badgeClass: string;
  requiresLegalAuthorizationForCrm: boolean;
}

export const TEMPORARY_QUEUE_OUTCOMES: TemporaryQueueOutcomeMeta[] = [
  {
    value: 'pendiente',
    label: 'Pendiente',
    badgeClass: 'bg-slate-100 text-slate-800 border-slate-300',
    requiresLegalAuthorizationForCrm: false,
  },
  {
    value: 'contacto_no_autorizado',
    label: 'Contacto no autorizado',
    badgeClass: 'bg-amber-50 text-amber-900 border-amber-300',
    requiresLegalAuthorizationForCrm: false,
  },
  {
    value: 'numero_incorrecto',
    label: 'Número incorrecto',
    badgeClass: 'bg-rose-50 text-rose-800 border-rose-300',
    requiresLegalAuthorizationForCrm: false,
  },
  {
    value: 'no_responde',
    label: 'No responde',
    badgeClass: 'bg-slate-100 text-slate-700 border-slate-300',
    requiresLegalAuthorizationForCrm: true,
  },
  {
    value: 'contacto_alcanzado',
    label: 'Contacto alcanzado',
    badgeClass: 'bg-sky-50 text-sky-900 border-sky-300',
    requiresLegalAuthorizationForCrm: true,
  },
  {
    value: 'no_interesado',
    label: 'No interesado',
    badgeClass: 'bg-slate-100 text-slate-600 border-slate-300',
    requiresLegalAuthorizationForCrm: true,
  },
  {
    value: 'interesado',
    label: 'Interesado',
    badgeClass: 'bg-purple-50 text-purple-900 border-purple-300',
    requiresLegalAuthorizationForCrm: true,
  },
  {
    value: 'cotizacion',
    label: 'Cotización',
    badgeClass: 'bg-indigo-50 text-indigo-900 border-indigo-300',
    requiresLegalAuthorizationForCrm: true,
  },
  {
    value: 'cliente',
    label: 'Cliente',
    badgeClass: 'bg-emerald-50 text-emerald-900 border-emerald-300',
    requiresLegalAuthorizationForCrm: true,
  },
  {
    value: 'descartado',
    label: 'Descartado',
    badgeClass: 'bg-rose-50 text-rose-900 border-rose-300',
    requiresLegalAuthorizationForCrm: false,
  },
];

export type TemporaryQueueTtlHours = 12 | 24;

export type TemporaryQueuePriority = 'alta' | 'normal' | 'baja';

export interface TemporaryQueueIndependentDraft {
  independentBusinessName: string;
  independentPhone: string;
  independentAddress: string;
  district: string;
  independentWebsite: string;
  independentEmail: string;
  independentCategory: string;
  confirmedNoWebsite: boolean;
  legalBasis: string;
  provenanceConfirmed: boolean;
  independentDataProvenance?: string;
}

export interface TemporaryQueueEntry {
  placeId: string;
  // Objeto vivo ya cargado en sesión por Explorador (0 llamadas adicionales; nunca guardado en Firestore/localStorage)
  lead: BusinessLead;
  addedAt: string;
  updatedAt?: string;
  followUpDate?: string;
  priorityLabel?: TemporaryQueuePriority;
  isSelected?: boolean;
  ttlHours?: TemporaryQueueTtlHours;
  expiresAt?: string;
  mapsSessionAvailable?: boolean;
  restoredFromPersistence?: boolean;
  searchCategory?: string;
  searchDistrict?: string;
  outcome: TemporaryQueueOutcome;
  notes: string;
  // Datos propios opcionales capturados/corroborados independientemente en sesión para traslado o recuperación 12h/24h
  independentData: TemporaryQueueIndependentDraft;
  promotedToCrmId?: string;
}

export interface PersistedTemporaryWorkItem {
  id: string;
  ownerUid: string;
  placeId: string;
  outcome: TemporaryQueueOutcome;
  notes: string;
  followUpDate: string;
  isSelected: boolean;
  priorityLabel: TemporaryQueuePriority;
  ttlHours: TemporaryQueueTtlHours;
  expiresAtEpochMs: number;
  searchCategory: string;
  searchDistrict: string;
  provenanceConfirmed: boolean;
  independentBusinessName: string;
  independentPhone: string;
  independentAddress: string;
  district: string;
  independentWebsite: string;
  independentEmail: string;
  independentCategory: string;
  confirmedNoWebsite: boolean;
  legalBasis: string;
  independentDataProvenance: string;
  promotedToCrmId: string;
  createdAt: string;
  updatedAt: string;
}


