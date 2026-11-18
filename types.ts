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

export interface GeminiComplementaryAnalysis {
  placeId: string;
  digitalNeeds: string[];
  recommendedWebnexServices: string[];
  commercialRelevance: string;
  missingInformation: string[];
  manualVerificationSteps: string[];
  analyzedSourceNote: string;
}

export interface LeadQualificationResult {
  placeId: string;
  tier: QualificationTier;
  digitalScore: number;
  contactabilityScore: number;
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
  stage: FollowupStage;
  legalBasis: string;
  qualificationTier: QualificationTier | '';
  aiSummary: string;
  notes: string;
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
