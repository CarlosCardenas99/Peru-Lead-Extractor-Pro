import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  onSnapshot,
  runTransaction,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp,
  Timestamp,
  query,
  where,
  orderBy,
  DocumentSnapshot,
  QueryDocumentSnapshot,
  DocumentData,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import {
  CommercialOutcomeType,
  CrmWorkspaceMode,
  DiscardRecord,
  ExclusionRecord,
  FOLLOWUP_STAGES,
  FollowupCompletenessInfo,
  FollowupIntegrityReport,
  FollowupLeadRecord,
  FollowupStage,
  PersistedTemporaryWorkItem,
  PhoneLineType,
  PhoneVerificationStage,
  QualificationTier,
  TEMPORARY_QUEUE_OUTCOMES,
  TemporaryQueueEntry,
  TemporaryQueueOutcome,
  TemporaryQueuePriority,
  TemporaryQueueTtlHours,
  WebsiteVerificationStatus,
} from '../types';
import { ParsedExclusionCandidate } from '../utils/exclusionUtils';
import {
  encodeOutcomeHistoryEntry,
  evaluateFollowupCompleteness,
  mergeOutcomeHistory,
  mergeVerificationSources,
  resolveIndependentPhoneType,
  resolveIndependentWebsiteStatusForSave,
} from '../utils/fieldCompliance';
import { validateLegalBasisForStage } from '../utils/leadQualifier';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export function formatFriendlyFirestoreError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('Quota exceeded') || raw.includes('resource-exhausted')) {
    return 'Se alcanzó la cuota gratuita diaria de Firebase Firestore (plan Spark). La cuota se restablece al día siguiente.';
  }
  if (raw.includes('Missing or insufficient permissions')) {
    return 'Acceso denegado por las reglas de seguridad de Firestore. Verifica que tu sesión de Google esté iniciada y con correo verificado.';
  }
  if (raw.includes('the client is offline')) {
    return 'Sin conexión con Firestore. Verifica tu red y configuración de Firebase.';
  }
  return 'Ocurrió un error al sincronizar con Firebase Firestore.';
}

export async function testFirestoreConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration (client is offline).');
      return false;
    }
    // Permission denied on default-deny test doc still proves live connectivity
    return true;
  }
}

export interface FirestorePreflightResult {
  ok: boolean;
  uid: string;
  email: string;
  writeVerified: boolean;
  readVerified: boolean;
  message: string;
}

export async function verifyUserFirestoreReadWrite(uid: string): Promise<FirestorePreflightResult> {
  const currentUser = auth.currentUser;
  if (!currentUser || !currentUser.emailVerified || currentUser.uid !== uid) {
    throw new Error('Debes iniciar sesión con Google (correo verificado) antes de escribir en Firestore.');
  }

  const probeId = '_healthcheck_probe';
  const path = `users/${uid}/exclusions/${probeId}`;
  const ref = doc(db, path);

  try {
    await setDoc(ref, {
      ownerUid: uid,
      type: 'placeId',
      normalizedValue: probeId,
      rawSample: 'preflight_check',
      sourceLabel: 'Verificacion escritura/lectura Firestore',
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }

  let readVerified = false;
  try {
    const snap = await getDocFromServer(ref);
    readVerified = snap.exists() && snap.data()?.ownerUid === uid;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  try {
    await deleteDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }

  if (!readVerified) {
    throw new Error('La escritura se ejecutó pero la lectura de verificación desde el servidor no devolvió el documento.');
  }

  return {
    ok: true,
    uid,
    email: currentUser.email || '',
    writeVerified: true,
    readVerified: true,
    message: `Sesión verificada (${currentUser.email || uid}): escritura, lectura desde servidor y limpieza en Firestore completadas correctamente.`,
  };
}

export async function signInWithGooglePopup(): Promise<User> {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

export async function signOutFirebase(): Promise<void> {
  await signOut(auth);
}

export function subscribeToAuth(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

function toIsoString(val: unknown): string {
  if (val instanceof Timestamp) return val.toDate().toISOString();
  if (typeof val === 'string') return val;
  return new Date().toISOString();
}

function buildSafeExclusionId(type: string, normalizedValue: string): string {
  let hash = 2166136261;
  const input = `${type}:${normalizedValue}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  const slug = normalizedValue.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return `${type}_${hex}_${slug || 'item'}`.slice(0, 128);
}

export function sanitizeFirestoreId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 150) || `id_${Date.now()}`;
}

export function getFollowupsCollectionPath(
  uid: string,
  workspaceMode: CrmWorkspaceMode = 'production'
): string {
  return `users/${uid}/${workspaceMode === 'sandbox' ? 'sandbox_followups' : 'followups'}`;
}

export function subscribeUserExclusions(
  uid: string,
  onData: (items: ExclusionRecord[]) => void,
  onError: (msg: string) => void
): () => void {
  const path = `users/${uid}/exclusions`;
  const q = query(collection(db, path), where('ownerUid', '==', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const items: ExclusionRecord[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ownerUid: String(data.ownerUid || uid),
          type: data.type,
          normalizedValue: String(data.normalizedValue || ''),
          rawSample: String(data.rawSample || ''),
          sourceLabel: String(data.sourceLabel || ''),
          createdAt: toIsoString(data.createdAt),
        };
      });
      onData(items);
    },
    (err) => {
      onError(formatFriendlyFirestoreError(err));
      try {
        handleFirestoreError(err, OperationType.LIST, path);
      } catch {
        // Already surfaced via onError
      }
    }
  );
}

export function subscribeUserDiscards(
  uid: string,
  onData: (items: DiscardRecord[]) => void,
  onError: (msg: string) => void
): () => void {
  const path = `users/${uid}/discards`;
  const q = query(collection(db, path), where('ownerUid', '==', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const items: DiscardRecord[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          placeId: String(data.placeId || d.id),
          ownerUid: String(data.ownerUid || uid),
          reason: String(data.reason || ''),
          discardedAt: toIsoString(data.discardedAt),
        };
      });
      onData(items);
    },
    (err) => {
      onError(formatFriendlyFirestoreError(err));
      try {
        handleFirestoreError(err, OperationType.LIST, path);
      } catch {
        // Already surfaced
      }
    }
  );
}

function normalizeStage(rawStage: unknown): FollowupStage {
  const str = String(rawStage || '').trim();
  if ((FOLLOWUP_STAGES as string[]).includes(str)) {
    return str as FollowupStage;
  }
  switch (str) {
    case 'Pendiente de revisión':
    case 'Verificado independientemente':
      return 'PENDIENTE DE VERIFICACIÓN';
    case 'Contactado legalmente':
      return 'CONTACTADO';
    case 'Respondió':
      return 'RESPONDIÓ';
    case 'Interesado':
      return 'INTERESADO';
    case 'Cotización':
      return 'COTIZACIÓN';
    case 'Cliente':
      return 'CLIENTE';
    case 'Descartado':
      return 'DESCARTADO';
    default:
      return 'PRESELECCIONADO';
  }
}

function mapFollowupSnapshotDoc(
  d: QueryDocumentSnapshot<DocumentData> | DocumentSnapshot<DocumentData>,
  uid: string
): FollowupLeadRecord {
  const data = d.data() || {};
  const verificationSources = Array.isArray(data.verificationSources)
    ? data.verificationSources
        .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
        .slice(0, 8)
    : undefined;

  const outcomeHistory = Array.isArray(data.outcomeHistory)
    ? data.outcomeHistory
        .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
        .slice(0, 10)
    : undefined;

  const completenessStatus =
    data.completenessStatus === 'complete' ||
    data.completenessStatus === 'partial' ||
    data.completenessStatus === 'place_id_only'
      ? data.completenessStatus
      : undefined;

  return {
    id: d.id,
    ownerUid: String(data.ownerUid || uid),
    placeId: String(data.placeId || ''),
    sourceKind:
      data.sourceKind === 'places_preselection' ? 'places_preselection' : 'independent_manual',
    independentBusinessName: String(data.independentBusinessName || ''),
    district: String(data.district || ''),
    confirmedNoWebsite: Boolean(data.confirmedNoWebsite),
    independentWebsiteStatus: (data.independentWebsiteStatus || 'unregistered') as WebsiteVerificationStatus,
    independentPhone: String(data.independentPhone || ''),
    phoneStage: (data.phoneStage || 'none') as PhoneVerificationStage,
    independentEmail: String(data.independentEmail || ''),
    independentDigitalScore: Number(data.independentDigitalScore || 0),
    independentContactScore: Number(data.independentContactScore || 0),
    independentTrustScore:
      typeof data.independentTrustScore === 'number'
        ? Math.max(0, Math.min(100, Math.round(data.independentTrustScore)))
        : undefined,
    completenessStatus,
    stage: normalizeStage(data.stage),
    legalBasis: String(data.legalBasis || ''),
    qualificationTier: (data.qualificationTier || '') as QualificationTier | '',
    aiSummary: String(data.aiSummary || ''),
    notes: String(data.notes || ''),
    independentAddress:
      typeof data.independentAddress === 'string' ? data.independentAddress : '',
    independentWebsite:
      typeof data.independentWebsite === 'string' ? data.independentWebsite : '',
    independentCategory:
      typeof data.independentCategory === 'string' ? data.independentCategory : '',
    independentPhoneType:
      typeof data.independentPhoneType === 'string'
        ? (data.independentPhoneType as PhoneLineType)
        : resolveIndependentPhoneType(String(data.independentPhone || '')),
    verificationSummary:
      typeof data.verificationSummary === 'string' ? data.verificationSummary : '',
    lastVerifiedAt:
      typeof data.lastVerifiedAt === 'string' ? data.lastVerifiedAt : '',
    verificationSources,
    commercialOutcome:
      typeof data.commercialOutcome === 'string'
        ? (data.commercialOutcome as CommercialOutcomeType)
        : undefined,
    outcomeSource: typeof data.outcomeSource === 'string' ? data.outcomeSource : undefined,
    outcomeContext: typeof data.outcomeContext === 'string' ? data.outcomeContext : undefined,
    outcomeRecordedAt:
      typeof data.outcomeRecordedAt === 'string' ? data.outcomeRecordedAt : undefined,
    outcomeHistory,
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
  };
}

export async function fetchFollowupsIntegritySnapshot(
  uid: string,
  workspaceMode: CrmWorkspaceMode = 'production'
): Promise<FollowupIntegrityReport> {
  const path = getFollowupsCollectionPath(uid, workspaceMode);
  try {
    const q = query(collection(db, path), where('ownerUid', '==', uid));
    const snapshot = await getDocsFromServer(q);
    const records = snapshot.docs
      .map((d) => mapFollowupSnapshotDoc(d, uid))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const uniqueDocIds = new Set(snapshot.docs.map((d) => d.id)).size;
    const uniquePlaceIds = new Set(
      records.map((r) => r.placeId.trim()).filter(Boolean)
    ).size;

    return {
      totalDocuments: snapshot.docs.length,
      uniqueDocIds,
      uniquePlaceIds,
      records,
      backedUpAt: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export function subscribeUserFollowups(
  uid: string,
  onData: (items: FollowupLeadRecord[]) => void,
  onError: (msg: string) => void,
  workspaceMode: CrmWorkspaceMode = 'production'
): () => void {
  const path = getFollowupsCollectionPath(uid, workspaceMode);
  const q = query(
    collection(db, path),
    where('ownerUid', '==', uid),
    orderBy('updatedAt', 'desc')
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => mapFollowupSnapshotDoc(d, uid));
      onData(items);
    },
    (err) => {
      onError(formatFriendlyFirestoreError(err));
      try {
        handleFirestoreError(err, OperationType.LIST, path);
      } catch {
        // Already surfaced
      }
    }
  );
}

export async function batchImportExclusions(
  uid: string,
  candidates: ParsedExclusionCandidate[],
  sourceLabel: string,
  onProgress?: (written: number, total: number) => void
): Promise<number> {
  const path = `users/${uid}/exclusions`;
  const CHUNK_SIZE = 400;
  let written = 0;

  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const slice = candidates.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const item of slice) {
      const docId = buildSafeExclusionId(item.type, item.normalizedValue);
      const ref = doc(db, path, docId);
      batch.set(ref, {
        ownerUid: uid,
        type: item.type,
        normalizedValue: item.normalizedValue.slice(0, 200),
        rawSample: item.rawSample.slice(0, 200),
        sourceLabel: sourceLabel.trim().slice(0, 120) || 'Importación manual',
        createdAt: serverTimestamp(),
      });
    }
    try {
      await batch.commit();
      written += slice.length;
      onProgress?.(written, candidates.length);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }
  return written;
}

export async function removeExclusionEntry(uid: string, exclusionId: string): Promise<void> {
  const path = `users/${uid}/exclusions/${exclusionId}`;
  try {
    await deleteDoc(doc(db, path));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function saveDiscardPlace(
  uid: string,
  placeId: string,
  reason: string
): Promise<void> {
  const safeId = sanitizeFirestoreId(placeId);
  const path = `users/${uid}/discards/${safeId}`;
  try {
    await setDoc(doc(db, path), {
      ownerUid: uid,
      placeId: safeId,
      reason: (reason || 'Descartado manualmente').trim().slice(0, 300),
      discardedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function removeDiscardPlace(uid: string, placeId: string): Promise<void> {
  const safeId = sanitizeFirestoreId(placeId);
  const path = `users/${uid}/discards/${safeId}`;
  try {
    await deleteDoc(doc(db, path));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export interface CreateFollowupOutcome {
  id: string;
  created: boolean;
  skippedExisting: boolean;
  persistedRecord: FollowupLeadRecord | null;
  completeness: FollowupCompletenessInfo | null;
}

export interface UpdateFollowupOutcome {
  persistedRecord: FollowupLeadRecord | null;
  completeness: FollowupCompletenessInfo | null;
}

export interface BatchCreateFollowupOutcome {
  created: number;
  skippedDuplicates: number;
  completeCreated: number;
  partialCreated: number;
  persistedRecords: FollowupLeadRecord[];
}

export function planNonDestructiveFollowupBatch<T extends { placeId: string }>(
  items: T[],
  existingPlaceIds: Set<string>
): { toCreate: T[]; skippedDuplicates: number } {
  const seenInBatch = new Set<string>();
  const toCreate: T[] = [];
  let skippedDuplicates = 0;

  for (const item of items) {
    const cleanPlaceId = sanitizeFirestoreId(item.placeId || '');
    if (
      !item.placeId ||
      existingPlaceIds.has(item.placeId) ||
      existingPlaceIds.has(cleanPlaceId) ||
      seenInBatch.has(cleanPlaceId)
    ) {
      skippedDuplicates += 1;
      continue;
    }
    seenInBatch.add(cleanPlaceId);
    toCreate.push(item);
  }

  return { toCreate, skippedDuplicates };
}

const ALLOWED_WEBSITE_STATUSES = new Set<WebsiteVerificationStatus>([
  'unregistered',
  'confirmed_none',
  'active_https',
  'active_http',
  'social_only',
  'unreachable_verified',
  'unverified_inconclusive',
  'invalid_url',
]);

const ALLOWED_PHONE_STAGES = new Set<PhoneVerificationStage>([
  'none',
  'registered_invalid',
  'registered_valid_format',
  'independently_corroborated',
  'contact_reached',
]);

const ALLOWED_PHONE_TYPES = new Set<PhoneLineType>([
  'none',
  'mobile',
  'landline_lima',
  'landline_regional',
  'invalid',
]);

const ALLOWED_QUALIFICATION_TIERS = new Set<QualificationTier | ''>([
  '',
  'PRIORIDAD ALTA',
  'REVISIÓN PENDIENTE',
  'NO ELEGIBLE',
]);

export function clampFirestoreScore(value: unknown, fallback = 0): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(100, Math.round(num)));
}

export function buildFollowupCreateDocPayload(
  uid: string,
  payload: Omit<FollowupLeadRecord, 'id' | 'ownerUid' | 'createdAt' | 'updatedAt'>,
  options?: { timestampValue?: unknown }
): Record<string, unknown> {
  const cleanPlaceId = sanitizeFirestoreId(payload.placeId || `manual_${Date.now()}`);
  const trimmedName = (payload.independentBusinessName || '').trim().slice(0, 160);
  const isManualWithoutPlaceId = !payload.placeId || payload.placeId.startsWith('manual_');

  let effectiveSourceKind: FollowupLeadRecord['sourceKind'] =
    payload.sourceKind === 'independent_manual' ? 'independent_manual' : 'places_preselection';

  if (effectiveSourceKind === 'independent_manual' && !trimmedName) {
    if (isManualWithoutPlaceId) {
      throw new Error('Debes ingresar el nombre comercial para crear un registro manual independiente.');
    }
    // Promociones parciales de un Place ID existente sin nombre comercial propio deben usar 'places_preselection'
    effectiveSourceKind = 'places_preselection';
  }

  const stage = normalizeStage(payload.stage);
  const legalBasis = (payload.legalBasis || '').trim().slice(0, 300);
  const gateError = validateLegalBasisForStage(stage, legalBasis);
  if (gateError) {
    throw new Error(gateError);
  }

  const phoneTrimmed = (payload.independentPhone || '').trim().slice(0, 40);
  const resolvedPhoneType = resolveIndependentPhoneType(phoneTrimmed, payload.independentPhoneType);
  const phoneType: PhoneLineType = ALLOWED_PHONE_TYPES.has(resolvedPhoneType)
    ? resolvedPhoneType
    : 'none';
  const websiteStatus: WebsiteVerificationStatus = ALLOWED_WEBSITE_STATUSES.has(
    payload.independentWebsiteStatus
  )
    ? payload.independentWebsiteStatus
    : payload.confirmedNoWebsite
    ? 'confirmed_none'
    : 'unregistered';
  const phoneStage: PhoneVerificationStage = ALLOWED_PHONE_STAGES.has(payload.phoneStage)
    ? payload.phoneStage
    : 'none';
  const qualificationTier: QualificationTier | '' = ALLOWED_QUALIFICATION_TIERS.has(
    payload.qualificationTier
  )
    ? payload.qualificationTier
    : '';

  const verificationSources = Array.isArray(payload.verificationSources)
    ? mergeVerificationSources([], payload.verificationSources, 8)
    : [];

  const completeness = evaluateFollowupCompleteness({
    independentBusinessName: trimmedName,
    independentPhone: phoneTrimmed,
    independentAddress: (payload.independentAddress || '').trim(),
    district: (payload.district || '').trim(),
    independentWebsite: (payload.independentWebsite || '').trim(),
    confirmedNoWebsite: Boolean(payload.confirmedNoWebsite),
    independentEmail: (payload.independentEmail || '').trim(),
    independentCategory: (payload.independentCategory || '').trim(),
  });
  const completenessStatus = completeness.status;

  const ts = options?.timestampValue ?? serverTimestamp();

  const docData: Record<string, unknown> = {
    ownerUid: uid,
    placeId: cleanPlaceId,
    sourceKind: effectiveSourceKind,
    independentBusinessName: trimmedName,
    district: (payload.district || '').trim().slice(0, 120),
    confirmedNoWebsite: Boolean(payload.confirmedNoWebsite),
    independentWebsiteStatus: websiteStatus,
    independentPhone: phoneTrimmed,
    phoneStage,
    independentEmail: (payload.independentEmail || '').trim().slice(0, 160),
    independentDigitalScore: clampFirestoreScore(payload.independentDigitalScore, 0),
    independentContactScore: clampFirestoreScore(payload.independentContactScore, 0),
    completenessStatus,
    stage,
    legalBasis,
    qualificationTier,
    aiSummary: (payload.aiSummary || '').trim().slice(0, 800),
    notes: (payload.notes || '').trim().slice(0, 1000),
    independentAddress: (payload.independentAddress || '').trim().slice(0, 200),
    independentWebsite: (payload.independentWebsite || '').trim().slice(0, 300),
    independentCategory: (payload.independentCategory || '').trim().slice(0, 120),
    independentPhoneType: phoneType,
    verificationSummary: (payload.verificationSummary || '').trim().slice(0, 400),
    lastVerifiedAt: (payload.lastVerifiedAt || '').trim().slice(0, 40),
    verificationSources,
    createdAt: ts,
    updatedAt: ts,
  };

  if (typeof payload.independentTrustScore === 'number' && Number.isFinite(payload.independentTrustScore)) {
    docData.independentTrustScore = clampFirestoreScore(payload.independentTrustScore, 0);
  }

  if (payload.commercialOutcome && payload.commercialOutcome !== 'none') {
    const recordedAt = (payload.outcomeRecordedAt || new Date().toISOString()).trim().slice(0, 40);
    const source = (payload.outcomeSource || 'registro_crm').trim().slice(0, 120);
    const context = (payload.outcomeContext || '').trim().slice(0, 300);
    docData.commercialOutcome = payload.commercialOutcome;
    docData.outcomeSource = source;
    docData.outcomeContext = context;
    docData.outcomeRecordedAt = recordedAt;
    docData.outcomeHistory = mergeOutcomeHistory(
      payload.outcomeHistory,
      encodeOutcomeHistoryEntry({
        outcome: payload.commercialOutcome,
        source,
        context,
        recordedAt,
      }),
      10
    );
  }

  return docData;
}

export async function createFollowupRecord(
  uid: string,
  payload: Omit<FollowupLeadRecord, 'id' | 'ownerUid' | 'createdAt' | 'updatedAt'>,
  workspaceMode: CrmWorkspaceMode = 'production'
): Promise<CreateFollowupOutcome> {
  const docData = buildFollowupCreateDocPayload(uid, payload);

  const collectionPath = getFollowupsCollectionPath(uid, workspaceMode);
  const cleanPlaceId = sanitizeFirestoreId(payload.placeId || '');
  const isManual = !payload.placeId || payload.placeId.startsWith('manual_');

  if (!isManual) {
    try {
      const serverSnap = await getDocsFromServer(
        query(collection(db, collectionPath), where('ownerUid', '==', uid))
      );
      const duplicateDoc = serverSnap.docs.find((d) => {
        const existingPlaceId = String(d.data().placeId || '').trim();
        return existingPlaceId === payload.placeId || existingPlaceId === cleanPlaceId;
      });
      if (duplicateDoc) {
        const existingMapped = mapFollowupSnapshotDoc(duplicateDoc, uid);
        return {
          id: duplicateDoc.id,
          created: false,
          skippedExisting: true,
          persistedRecord: existingMapped,
          completeness: evaluateFollowupCompleteness(existingMapped),
        };
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, collectionPath);
    }
  }

  const safeId = sanitizeFirestoreId(
    payload.placeId ? `lead_${payload.placeId}` : `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  );
  const docPath = `${collectionPath}/${safeId}`;
  const ref = doc(db, docPath);

  let wasCreated = false;
  try {
    wasCreated = await runTransaction(db, async (tx) => {
      const existingSnap = await tx.get(ref);
      if (existingSnap.exists()) {
        return false;
      }
      tx.set(ref, docData);
      return true;
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, docPath);
  }

  let persistedRecord: FollowupLeadRecord | null = null;
  let completeness: FollowupCompletenessInfo | null = null;
  try {
    const verifiedSnap = await getDocFromServer(ref);
    if (verifiedSnap.exists()) {
      persistedRecord = mapFollowupSnapshotDoc(verifiedSnap, uid);
      completeness = evaluateFollowupCompleteness(persistedRecord);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, docPath);
  }

  return {
    id: safeId,
    created: wasCreated,
    skippedExisting: !wasCreated,
    persistedRecord,
    completeness,
  };
}

export interface PreselectedBatchItemInput {
  placeId: string;
  independentBusinessName?: string;
  district?: string;
  independentPhone?: string;
  independentPhoneType?: PhoneLineType;
  independentAddress?: string;
  independentWebsite?: string;
  independentEmail?: string;
  independentCategory?: string;
  verificationSummary?: string;
  lastVerifiedAt?: string;
  verificationSources?: string[];
  confirmedNoWebsite: boolean;
  independentWebsiteStatus: WebsiteVerificationStatus;
  phoneStage: PhoneVerificationStage;
  independentDigitalScore: number;
  independentContactScore: number;
  independentTrustScore?: number;
  completenessStatus?: 'complete' | 'partial' | 'place_id_only';
  stage: 'PRESELECCIONADO' | 'PENDIENTE DE VERIFICACIÓN';
  qualificationTier: QualificationTier;
  aiSummary: string;
  notes: string;
}

/**
 * Transfiere en lote leads preseleccionados desde Explorador guardando Place ID, metadatos propios
 * y los campos comerciales corroborados independientemente (web oficial o captura legítima).
 * Nunca copia contenido restringido de Google Maps como si fuera verificación independiente y usa
 * transacciones atómicas para NUNCA sobrescribir registros existentes.
 */
export async function createBatchPreselectedFollowups(
  uid: string,
  items: PreselectedBatchItemInput[],
  existingPlaceIds: Set<string>,
  workspaceMode: CrmWorkspaceMode = 'production'
): Promise<BatchCreateFollowupOutcome> {
  const path = getFollowupsCollectionPath(uid, workspaceMode);
  const authoritativeExisting = new Set<string>(existingPlaceIds);

  try {
    const serverSnapshot = await getDocsFromServer(
      query(collection(db, path), where('ownerUid', '==', uid))
    );
    for (const d of serverSnapshot.docs) {
      const pid = String(d.data().placeId || '').trim();
      if (pid) {
        authoritativeExisting.add(pid);
        authoritativeExisting.add(sanitizeFirestoreId(pid));
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }

  const planned = planNonDestructiveFollowupBatch(items, authoritativeExisting);
  let created = 0;
  let skippedDuplicates = planned.skippedDuplicates;
  let completeCreated = 0;
  let partialCreated = 0;
  const persistedRecords: FollowupLeadRecord[] = [];

  for (const item of planned.toCreate) {
    const cleanPlaceId = sanitizeFirestoreId(item.placeId);
    const docId = sanitizeFirestoreId(`lead_${cleanPlaceId}`);
    const ref = doc(db, path, docId);
    const docPayload = buildFollowupCreateDocPayload(uid, {
      placeId: cleanPlaceId,
      sourceKind: 'places_preselection',
      independentBusinessName: item.independentBusinessName || '',
      district: item.district || '',
      confirmedNoWebsite: Boolean(item.confirmedNoWebsite),
      independentWebsiteStatus: item.independentWebsiteStatus,
      independentPhone: item.independentPhone || '',
      independentPhoneType: item.independentPhoneType,
      phoneStage: item.phoneStage,
      independentEmail: item.independentEmail || '',
      independentDigitalScore: item.independentDigitalScore,
      independentContactScore: item.independentContactScore,
      independentTrustScore: item.independentTrustScore,
      completenessStatus: item.completenessStatus,
      stage: item.stage,
      legalBasis: '',
      qualificationTier: item.qualificationTier,
      aiSummary: item.aiSummary || '',
      notes: item.notes || '',
      independentAddress: item.independentAddress || '',
      independentWebsite: item.independentWebsite || '',
      independentCategory: item.independentCategory || '',
      verificationSummary: item.verificationSummary || '',
      lastVerifiedAt: item.lastVerifiedAt || '',
      verificationSources: item.verificationSources,
    });

    let wasCreated = false;
    try {
      wasCreated = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) {
          return false;
        }
        tx.set(ref, docPayload);
        return true;
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `${path}/${docId}`);
    }

    if (wasCreated) {
      created += 1;
      try {
        const verifiedSnap = await getDocFromServer(ref);
        if (verifiedSnap.exists()) {
          const rec = mapFollowupSnapshotDoc(verifiedSnap, uid);
          persistedRecords.push(rec);
          if (evaluateFollowupCompleteness(rec).status === 'complete') {
            completeCreated += 1;
          } else {
            partialCreated += 1;
          }
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `${path}/${docId}`);
      }
    } else {
      skippedDuplicates += 1;
    }
  }

  return {
    created,
    skippedDuplicates,
    completeCreated,
    partialCreated,
    persistedRecords,
  };
}

export async function updateFollowupRecord(
  uid: string,
  followupId: string,
  updates: Partial<
    Pick<
      FollowupLeadRecord,
      | 'independentBusinessName'
      | 'district'
      | 'confirmedNoWebsite'
      | 'independentWebsiteStatus'
      | 'independentPhone'
      | 'independentPhoneType'
      | 'phoneStage'
      | 'independentEmail'
      | 'independentAddress'
      | 'independentWebsite'
      | 'independentCategory'
      | 'verificationSummary'
      | 'lastVerifiedAt'
      | 'verificationSources'
      | 'independentDigitalScore'
      | 'independentContactScore'
      | 'independentTrustScore'
      | 'completenessStatus'
      | 'commercialOutcome'
      | 'outcomeSource'
      | 'outcomeContext'
      | 'outcomeRecordedAt'
      | 'outcomeHistory'
      | 'stage'
      | 'legalBasis'
      | 'qualificationTier'
      | 'aiSummary'
      | 'notes'
    >
  >,
  currentRecord?: FollowupLeadRecord,
  workspaceMode: CrmWorkspaceMode = 'production'
): Promise<UpdateFollowupOutcome> {
  const safeId = sanitizeFirestoreId(followupId);
  const path = `${getFollowupsCollectionPath(uid, workspaceMode)}/${safeId}`;
  const ref = doc(db, path);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        throw new Error('El registro ya no existe en Firestore.');
      }
      const existingData = snap.data();
      const currentStage = normalizeStage(existingData.stage ?? currentRecord?.stage);
      const nextStage = typeof updates.stage === 'string' ? updates.stage : currentStage;

      const effectiveLegalBasis =
        typeof updates.legalBasis === 'string'
          ? updates.legalBasis
          : String(existingData.legalBasis || currentRecord?.legalBasis || '');

      const gateError = validateLegalBasisForStage(nextStage, effectiveLegalBasis);
      if (gateError) {
        throw new Error(gateError);
      }

      const buildOutcomePatch = (): Record<string, unknown> => {
        const outcomePatch: Record<string, unknown> = {};
        if (typeof updates.commercialOutcome === 'string') {
          const recordedAt = (updates.outcomeRecordedAt || new Date().toISOString())
            .trim()
            .slice(0, 40);
          const source = (updates.outcomeSource || 'registro_crm').trim().slice(0, 120);
          const context = (updates.outcomeContext || '').trim().slice(0, 300);
          outcomePatch.commercialOutcome = updates.commercialOutcome;
          outcomePatch.outcomeSource = source;
          outcomePatch.outcomeContext = context;
          outcomePatch.outcomeRecordedAt = recordedAt;
          const existingHistory = Array.isArray(existingData.outcomeHistory)
            ? existingData.outcomeHistory.filter((s: unknown): s is string => typeof s === 'string')
            : [];
          outcomePatch.outcomeHistory = mergeOutcomeHistory(
            existingHistory,
            encodeOutcomeHistoryEntry({
              outcome: updates.commercialOutcome,
              source,
              context,
              recordedAt,
            }),
            10
          );
        } else {
          if (typeof updates.outcomeSource === 'string') {
            outcomePatch.outcomeSource = updates.outcomeSource.trim().slice(0, 120);
          }
          if (typeof updates.outcomeContext === 'string') {
            outcomePatch.outcomeContext = updates.outcomeContext.trim().slice(0, 300);
          }
          if (typeof updates.outcomeRecordedAt === 'string') {
            outcomePatch.outcomeRecordedAt = updates.outcomeRecordedAt.trim().slice(0, 40);
          }
        }
        return outcomePatch;
      };

      if (currentStage === 'CLIENTE') {
        const clientPatch: Record<string, unknown> = {
          ...buildOutcomePatch(),
        };
        if (typeof updates.notes === 'string') {
          clientPatch.notes = updates.notes.trim().slice(0, 1000);
        }
        if (Object.keys(clientPatch).length === 0) {
          return;
        }
        clientPatch.updatedAt = serverTimestamp();
        tx.update(ref, clientPatch);
        return;
      }

      const cleanPayload: Record<string, unknown> = {
        ...buildOutcomePatch(),
        updatedAt: serverTimestamp(),
      };

      if (typeof updates.independentBusinessName === 'string') {
        cleanPayload.independentBusinessName = updates.independentBusinessName.trim().slice(0, 160);
      }
      if (typeof updates.district === 'string') {
        cleanPayload.district = updates.district.trim().slice(0, 120);
      }
      if (typeof updates.independentAddress === 'string') {
        cleanPayload.independentAddress = updates.independentAddress.trim().slice(0, 200);
      }
      if (typeof updates.independentWebsite === 'string') {
        cleanPayload.independentWebsite = updates.independentWebsite.trim().slice(0, 300);
      }
      if (typeof updates.independentCategory === 'string') {
        cleanPayload.independentCategory = updates.independentCategory.trim().slice(0, 120);
      }
      if (typeof updates.confirmedNoWebsite === 'boolean') {
        cleanPayload.confirmedNoWebsite = updates.confirmedNoWebsite;
      }
      if (typeof updates.independentWebsiteStatus === 'string') {
        cleanPayload.independentWebsiteStatus = updates.independentWebsiteStatus;
      }
      if (typeof updates.independentPhone === 'string') {
        const phoneTrimmed = updates.independentPhone.trim().slice(0, 40);
        cleanPayload.independentPhone = phoneTrimmed;
        cleanPayload.independentPhoneType = resolveIndependentPhoneType(
          phoneTrimmed,
          updates.independentPhoneType
        );
      } else if (typeof updates.independentPhoneType === 'string') {
        cleanPayload.independentPhoneType = updates.independentPhoneType;
      }
      if (typeof updates.phoneStage === 'string') {
        cleanPayload.phoneStage = updates.phoneStage;
      }
      if (typeof updates.independentEmail === 'string') {
        cleanPayload.independentEmail = updates.independentEmail.trim().slice(0, 160);
      }
      if (typeof updates.independentDigitalScore === 'number' && Number.isFinite(updates.independentDigitalScore)) {
        cleanPayload.independentDigitalScore = clampFirestoreScore(updates.independentDigitalScore, 0);
      }
      if (typeof updates.independentContactScore === 'number' && Number.isFinite(updates.independentContactScore)) {
        cleanPayload.independentContactScore = clampFirestoreScore(updates.independentContactScore, 0);
      }
      if (typeof updates.independentTrustScore === 'number' && Number.isFinite(updates.independentTrustScore)) {
        cleanPayload.independentTrustScore = clampFirestoreScore(updates.independentTrustScore, 0);
      }
      const mergedCompleteness = evaluateFollowupCompleteness({
        independentBusinessName: String(
          cleanPayload.independentBusinessName ?? existingData.independentBusinessName ?? ''
        ),
        independentPhone: String(cleanPayload.independentPhone ?? existingData.independentPhone ?? ''),
        independentAddress: String(
          cleanPayload.independentAddress ?? existingData.independentAddress ?? ''
        ),
        district: String(cleanPayload.district ?? existingData.district ?? ''),
        independentWebsite: String(
          cleanPayload.independentWebsite ?? existingData.independentWebsite ?? ''
        ),
        confirmedNoWebsite:
          typeof cleanPayload.confirmedNoWebsite === 'boolean'
            ? cleanPayload.confirmedNoWebsite
            : Boolean(existingData.confirmedNoWebsite),
        independentEmail: String(cleanPayload.independentEmail ?? existingData.independentEmail ?? ''),
        independentCategory: String(
          cleanPayload.independentCategory ?? existingData.independentCategory ?? ''
        ),
      });
      cleanPayload.completenessStatus = mergedCompleteness.status;
      if (typeof updates.stage === 'string') {
        cleanPayload.stage = updates.stage;
      }
      if (typeof updates.legalBasis === 'string') {
        cleanPayload.legalBasis = updates.legalBasis.trim().slice(0, 300);
      }
      if (typeof updates.qualificationTier === 'string') {
        cleanPayload.qualificationTier = updates.qualificationTier;
      }
      if (typeof updates.aiSummary === 'string') {
        cleanPayload.aiSummary = updates.aiSummary.trim().slice(0, 800);
      }
      if (typeof updates.notes === 'string') {
        cleanPayload.notes = updates.notes.trim().slice(0, 1000);
      }
      if (typeof updates.verificationSummary === 'string') {
        cleanPayload.verificationSummary = updates.verificationSummary.trim().slice(0, 400);
      }
      if (typeof updates.lastVerifiedAt === 'string') {
        cleanPayload.lastVerifiedAt = updates.lastVerifiedAt.trim().slice(0, 40);
      }
      if (Array.isArray(updates.verificationSources)) {
        const existingSources = Array.isArray(existingData.verificationSources)
          ? existingData.verificationSources.filter((s: unknown): s is string => typeof s === 'string')
          : [];
        cleanPayload.verificationSources = mergeVerificationSources(
          existingSources,
          updates.verificationSources,
          8
        );
      }

      tx.update(ref, cleanPayload);
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }

  let persistedRecord: FollowupLeadRecord | null = null;
  let completeness: FollowupCompletenessInfo | null = null;
  try {
    const verifiedSnap = await getDocFromServer(ref);
    if (verifiedSnap.exists()) {
      persistedRecord = mapFollowupSnapshotDoc(verifiedSnap, uid);
      completeness = evaluateFollowupCompleteness(persistedRecord);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  return { persistedRecord, completeness };
}

export interface MissingFieldRecoveryProposal {
  id: string;
  independentBusinessName?: string;
  independentPhone?: string;
  independentPhoneType?: PhoneLineType;
  independentAddress?: string;
  district?: string;
  independentWebsite?: string;
  independentEmail?: string;
  independentCategory?: string;
  verificationSummary?: string;
  lastVerifiedAt?: string;
  verificationSources?: string[];
}

/**
 * Calcula un parche estrictamente parcial con ÚNICAMENTE los campos comerciales actualmente vacíos
 * en el documento de Firestore. Nunca sobrescribe campos ya poblados, notas, etapas, base legal ni fechas.
 */
export function buildMissingFieldsPatch(
  existingDocData: Partial<FollowupLeadRecord>,
  proposal: Omit<MissingFieldRecoveryProposal, 'id'>
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (existingDocData.stage === 'CLIENTE') {
    return patch;
  }

  const fillIfEmpty = (
    key:
      | 'independentBusinessName'
      | 'independentPhone'
      | 'independentAddress'
      | 'district'
      | 'independentWebsite'
      | 'independentEmail'
      | 'independentCategory',
    rawVal: string | undefined,
    maxLen: number
  ) => {
    const existingVal = String(existingDocData[key] || '').trim();
    const candidateVal = String(rawVal || '').trim().slice(0, maxLen);
    if (!existingVal && candidateVal) {
      patch[key] = candidateVal;
    }
  };

  fillIfEmpty('independentBusinessName', proposal.independentBusinessName, 160);
  fillIfEmpty('independentPhone', proposal.independentPhone, 40);
  fillIfEmpty('independentAddress', proposal.independentAddress, 200);
  fillIfEmpty('district', proposal.district, 120);
  fillIfEmpty('independentWebsite', proposal.independentWebsite, 300);
  fillIfEmpty('independentEmail', proposal.independentEmail, 160);
  fillIfEmpty('independentCategory', proposal.independentCategory, 120);

  if (typeof patch.independentPhone === 'string') {
    patch.independentPhoneType = resolveIndependentPhoneType(
      patch.independentPhone,
      proposal.independentPhoneType
    );
    if (!existingDocData.phoneStage || existingDocData.phoneStage === 'none') {
      patch.phoneStage = 'independently_corroborated';
    }
  }

  if (typeof patch.independentWebsite === 'string') {
    const existingStatus = existingDocData.independentWebsiteStatus;
    if (!existingStatus || existingStatus === 'unregistered') {
      patch.independentWebsiteStatus = resolveIndependentWebsiteStatusForSave({
        independentWebsite: patch.independentWebsite,
        confirmedNoWebsite: Boolean(existingDocData.confirmedNoWebsite),
        verifiedProbe: null,
      });
    }
  }

  if (Object.keys(patch).length > 0) {
    if (proposal.verificationSummary?.trim()) {
      patch.verificationSummary = proposal.verificationSummary.trim().slice(0, 400);
    }
    if (proposal.lastVerifiedAt?.trim()) {
      patch.lastVerifiedAt = proposal.lastVerifiedAt.trim().slice(0, 40);
    }
    if (Array.isArray(proposal.verificationSources) && proposal.verificationSources.length > 0) {
      const existingSources = Array.isArray(existingDocData.verificationSources)
        ? existingDocData.verificationSources
        : [];
      patch.verificationSources = mergeVerificationSources(
        existingSources,
        proposal.verificationSources,
        8
      );
    }
  }

  return patch;
}

/**
 * Ejecuta recuperación no destructiva por transacción sobre registros existentes en Seguimiento:
 * completa ÚNICAMENTE campos comerciales vacíos; jamás sobrescribe etapas, notas, base legal,
 * fechas de creación ni datos previos del usuario.
 */
export async function recoverMissingFollowupFieldsBatch(
  uid: string,
  proposals: MissingFieldRecoveryProposal[],
  workspaceMode: CrmWorkspaceMode = 'production'
): Promise<{
  updatedRecords: number;
  skippedRecords: number;
  fieldsCompleted: number;
  verifiedRecords: FollowupLeadRecord[];
}> {
  let updatedRecords = 0;
  let skippedRecords = 0;
  let fieldsCompleted = 0;
  const verifiedRecords: FollowupLeadRecord[] = [];
  const collectionPath = getFollowupsCollectionPath(uid, workspaceMode);

  for (const proposal of proposals) {
    const safeId = sanitizeFirestoreId(proposal.id);
    if (!safeId) {
      skippedRecords += 1;
      continue;
    }
    const path = `${collectionPath}/${safeId}`;
    const ref = doc(db, path);

    try {
      const filledThisDoc = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) return -1;
        const existingData = snap.data();
        const existingMapped: Partial<FollowupLeadRecord> = {
          stage: normalizeStage(existingData.stage),
          phoneStage: (existingData.phoneStage || 'none') as PhoneVerificationStage,
          independentBusinessName: String(existingData.independentBusinessName || ''),
          independentPhone: String(existingData.independentPhone || ''),
          independentAddress: String(existingData.independentAddress || ''),
          district: String(existingData.district || ''),
          independentWebsite: String(existingData.independentWebsite || ''),
          independentEmail: String(existingData.independentEmail || ''),
          independentCategory: String(existingData.independentCategory || ''),
          confirmedNoWebsite: Boolean(existingData.confirmedNoWebsite),
          verificationSources: Array.isArray(existingData.verificationSources)
            ? existingData.verificationSources.filter(
                (s: unknown): s is string => typeof s === 'string'
              )
            : [],
        };

        const patch = buildMissingFieldsPatch(existingMapped, proposal);
        const commercialKeysCount = Object.keys(patch).filter((k) =>
          [
            'independentBusinessName',
            'independentPhone',
            'independentAddress',
            'district',
            'independentWebsite',
            'independentEmail',
            'independentCategory',
          ].includes(k)
        ).length;

        if (commercialKeysCount === 0) {
          return 0;
        }

        const mergedCompleteness = evaluateFollowupCompleteness({
          independentBusinessName: String(
            patch.independentBusinessName ?? existingMapped.independentBusinessName ?? ''
          ),
          independentPhone: String(patch.independentPhone ?? existingMapped.independentPhone ?? ''),
          independentAddress: String(
            patch.independentAddress ?? existingMapped.independentAddress ?? ''
          ),
          district: String(patch.district ?? existingMapped.district ?? ''),
          independentWebsite: String(
            patch.independentWebsite ?? existingMapped.independentWebsite ?? ''
          ),
          confirmedNoWebsite: Boolean(existingMapped.confirmedNoWebsite),
          independentEmail: String(patch.independentEmail ?? existingMapped.independentEmail ?? ''),
          independentCategory: String(
            patch.independentCategory ?? existingMapped.independentCategory ?? ''
          ),
        });

        tx.update(ref, {
          ...patch,
          completenessStatus: mergedCompleteness.status,
          updatedAt: serverTimestamp(),
        });
        return commercialKeysCount;
      });

      if (filledThisDoc > 0) {
        updatedRecords += 1;
        fieldsCompleted += filledThisDoc;
        try {
          const verifiedSnap = await getDocFromServer(ref);
          if (verifiedSnap.exists()) {
            verifiedRecords.push(mapFollowupSnapshotDoc(verifiedSnap, uid));
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.GET, path);
        }
      } else {
        skippedRecords += 1;
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  }

  return { updatedRecords, skippedRecords, fieldsCompleted, verifiedRecords };
}

export interface LegacyCleanupCandidatePreview {
  id: string;
  placeId: string;
  stage: FollowupStage;
  businessName: string;
  completenessLabel: string;
  protectedReason: string | null;
  eligibleForFutureCleanup: boolean;
}

export interface SafeLegacyCleanupPreview {
  backupVerified: boolean;
  totalRecords: number;
  protectedClientesCount: number;
  protectedExclusionsCount: number;
  completeRecordsCount: number;
  incompleteCleanupCandidatesCount: number;
  candidates: LegacyCleanupCandidatePreview[];
  executionBlocked: true;
  blockingReason: string;
}

/**
 * FASE 8 — Vista previa estrictamente de solo lectura para evaluar una limpieza futura posterior
 * a la validación en el Espacio Aislado de Pruebas. Nunca ejecuta deleteDoc automáticamente.
 */
export function buildSafeLegacyCleanupPreview(
  records: FollowupLeadRecord[],
  options: { backupVerified: boolean; exclusionPlaceIds: Set<string> }
): SafeLegacyCleanupPreview {
  let protectedClientesCount = 0;
  let protectedExclusionsCount = 0;
  let completeRecordsCount = 0;
  let incompleteCleanupCandidatesCount = 0;

  const candidates: LegacyCleanupCandidatePreview[] = records.map((rec) => {
    const completeness = evaluateFollowupCompleteness(rec);
    const isClient = rec.stage === 'CLIENTE';
    const isExclusionMatch = Boolean(rec.placeId && options.exclusionPlaceIds.has(rec.placeId));

    let protectedReason: string | null = null;
    if (isClient) {
      protectedClientesCount += 1;
      protectedReason = 'Protegido: etapa CLIENTE consolidado.';
    } else if (isExclusionMatch) {
      protectedExclusionsCount += 1;
      protectedReason = 'Protegido: forma parte del listado de exclusiones.';
    } else if (!completeness.isFichaIncompleta) {
      completeRecordsCount += 1;
      protectedReason = 'Protegido: ficha comercial persistente completa.';
    }

    const eligibleForFutureCleanup = protectedReason === null && completeness.isFichaIncompleta;
    if (eligibleForFutureCleanup) {
      incompleteCleanupCandidatesCount += 1;
    }

    return {
      id: rec.id,
      placeId: rec.placeId,
      stage: rec.stage,
      businessName: rec.independentBusinessName || 'Sin nombre independiente',
      completenessLabel: completeness.label,
      protectedReason,
      eligibleForFutureCleanup,
    };
  });

  return {
    backupVerified: options.backupVerified,
    totalRecords: records.length,
    protectedClientesCount,
    protectedExclusionsCount,
    completeRecordsCount,
    incompleteCleanupCandidatesCount,
    candidates,
    executionBlocked: true,
    blockingReason: options.backupVerified
      ? 'Limpieza bloqueada durante Fase 8: los 52 registros actuales se conservan intactos hasta completar pruebas en Sandbox y recibir confirmación manual explícita.'
      : 'Se requiere verificar el respaldo JSON antes de autorizar cualquier limpieza futura.',
  };
}

export interface BatchDeleteProgress {
  processed: number;
  total: number;
  deleted: number;
  failed: number;
}

export interface BatchDeleteFailedItem {
  id: string;
  error: string;
}

export interface BatchDeleteFollowupsResult {
  workspaceMode: CrmWorkspaceMode;
  collectionPath: string;
  totalRequested: number;
  deletedIds: string[];
  failedItems: BatchDeleteFailedItem[];
  abortedReason?: string;
}

export interface FirestoreDeleteBatchAdapter {
  commitDeleteChunk: (collectionPath: string, ids: string[]) => Promise<void>;
  deleteSingleDoc: (collectionPath: string, id: string) => Promise<void>;
}

const defaultFirestoreDeleteAdapter: FirestoreDeleteBatchAdapter = {
  async commitDeleteChunk(collectionPath: string, ids: string[]) {
    const batch = writeBatch(db);
    for (const id of ids) {
      batch.delete(doc(db, collectionPath, id));
    }
    await batch.commit();
  },
  async deleteSingleDoc(collectionPath: string, id: string) {
    await deleteDoc(doc(db, collectionPath, id));
  },
};

/**
 * FASE 3 — Borrado controlado de registros de Seguimiento en Firestore (Producción o Sandbox).
 * - Exige backupVerified === true previo a ejecutar.
 * - Opera EXCLUSIVAMENTE sobre users/{uid}/followups o users/{uid}/sandbox_followups.
 * - Nunca toca exclusions, discards, usuarios, reglas ni Auth.
 * - Ejecuta en lotes (<= 400) reportando progreso y aislando errores parciales por ID.
 */
export async function deleteFollowupsBatchWithProgress(
  options: {
    uid: string;
    workspaceMode: CrmWorkspaceMode;
    docIds: string[];
    backupVerified: boolean;
    chunkSize?: number;
    onProgress?: (progress: BatchDeleteProgress) => void;
  },
  adapter: FirestoreDeleteBatchAdapter = defaultFirestoreDeleteAdapter
): Promise<BatchDeleteFollowupsResult> {
  const { uid, workspaceMode, backupVerified, onProgress } = options;
  if (!uid || !uid.trim()) {
    throw new Error('UID de usuario requerido para eliminar registros en Firestore.');
  }
  if (!backupVerified) {
    throw new Error(
      'Debes generar y descargar primero el respaldo JSON de Seguimiento antes de eliminar registros en Firestore.'
    );
  }

  const collectionPath = getFollowupsCollectionPath(uid, workspaceMode);
  if (!collectionPath.endsWith('/followups') && !collectionPath.endsWith('/sandbox_followups')) {
    throw new Error(`Ruta de colección no autorizada para limpieza de Seguimiento: ${collectionPath}`);
  }

  const uniqueIds = Array.from(
    new Set(
      (options.docIds || [])
        .map((id) => sanitizeFirestoreId(id.trim()))
        .filter((id) => Boolean(id))
    )
  );

  const totalRequested = uniqueIds.length;
  const deletedIds: string[] = [];
  const failedItems: BatchDeleteFailedItem[] = [];

  if (totalRequested === 0) {
    return {
      workspaceMode,
      collectionPath,
      totalRequested: 0,
      deletedIds: [],
      failedItems: [],
    };
  }

  const safeChunkSize = Math.max(1, Math.min(400, options.chunkSize ?? 25));
  let processed = 0;

  for (let i = 0; i < uniqueIds.length; i += safeChunkSize) {
    const chunk = uniqueIds.slice(i, i + safeChunkSize);
    try {
      await adapter.commitDeleteChunk(collectionPath, chunk);
      deletedIds.push(...chunk);
      processed += chunk.length;
      onProgress?.({
        processed,
        total: totalRequested,
        deleted: deletedIds.length,
        failed: failedItems.length,
      });
    } catch {
      // Fallback por documento para aislar fallos parciales y no perder progreso de los demás IDs
      for (const id of chunk) {
        const docPath = `${collectionPath}/${id}`;
        try {
          await adapter.deleteSingleDoc(collectionPath, id);
          deletedIds.push(id);
        } catch (singleErr) {
          let errMsg = singleErr instanceof Error ? singleErr.message : String(singleErr);
          if (errMsg.includes('Missing or insufficient permissions')) {
            try {
              handleFirestoreError(singleErr, OperationType.DELETE, docPath);
            } catch (formattedErr) {
              errMsg = formattedErr instanceof Error ? formattedErr.message : errMsg;
            }
          }
          failedItems.push({ id, error: errMsg });
        }
        processed += 1;
        onProgress?.({
          processed,
          total: totalRequested,
          deleted: deletedIds.length,
          failed: failedItems.length,
        });
      }
    }
  }

  return {
    workspaceMode,
    collectionPath,
    totalRequested,
    deletedIds,
    failedItems,
  };
}

const ALLOWED_TEMPORARY_OUTCOMES = new Set<TemporaryQueueOutcome>(
  TEMPORARY_QUEUE_OUTCOMES.map((o) => o.value)
);

const ALLOWED_TEMPORARY_PRIORITIES = new Set<TemporaryQueuePriority>(['alta', 'normal', 'baja']);

export function getTemporaryWorkQueueCollectionPath(uid: string): string {
  return `users/${uid}/temporary_work_queue`;
}

/**
 * Construye el payload seguro para /users/{uid}/temporary_work_queue/{itemId} con TTL lógico (12h o 24h).
 * - Guarda EXCLUSIVAMENTE: Place ID, notas propias, resultado de gestión, fecha de seguimiento,
 *   selecciones/prioridades propias y datos comerciales independientes autorizados.
 * - NUNCA persiste contenido restringido de Google Maps (nombre/teléfono/dirección/web de Maps);
 *   si provenanceConfirmed !== true, los campos comerciales de terceros se fuerzan a ''.
 */
export function buildTemporaryWorkItemPayload(
  uid: string,
  entry: TemporaryQueueEntry,
  ttlHours: TemporaryQueueTtlHours = 24,
  options?: { nowMs?: number; timestampValue?: unknown }
): Record<string, unknown> {
  const cleanPlaceId = sanitizeFirestoreId(entry.placeId || '');
  if (!cleanPlaceId) {
    throw new Error('Place ID válido requerido para respaldar elemento de cola temporal.');
  }
  const safeTtl: TemporaryQueueTtlHours = ttlHours === 12 ? 12 : 24;
  const nowMs = options?.nowMs ?? Date.now();
  const expiresAtEpochMs = nowMs + safeTtl * 60 * 60 * 1000;
  const ts = options?.timestampValue ?? serverTimestamp();

  const outcome: TemporaryQueueOutcome = ALLOWED_TEMPORARY_OUTCOMES.has(entry.outcome)
    ? entry.outcome
    : 'pendiente';
  const priorityLabel: TemporaryQueuePriority =
    entry.priorityLabel && ALLOWED_TEMPORARY_PRIORITIES.has(entry.priorityLabel)
      ? entry.priorityLabel
      : 'normal';

  const ind = entry.independentData;
  const provenanceConfirmed = Boolean(ind.provenanceConfirmed);
  const rawProvenance = (ind.independentDataProvenance || '').trim();
  const effectiveProvenance = provenanceConfirmed
    ? (rawProvenance || 'user_manual_entry').slice(0, 160)
    : '';

  return {
    ownerUid: uid,
    placeId: cleanPlaceId,
    outcome,
    notes: (entry.notes || '').trim().slice(0, 1000),
    followUpDate: (entry.followUpDate || '').trim().slice(0, 40),
    isSelected: Boolean(entry.isSelected),
    priorityLabel,
    ttlHours: safeTtl,
    expiresAtEpochMs,
    searchCategory: (entry.searchCategory || '').trim().slice(0, 120),
    searchDistrict: (entry.searchDistrict || '').trim().slice(0, 120),
    provenanceConfirmed,
    independentBusinessName: provenanceConfirmed
      ? (ind.independentBusinessName || '').trim().slice(0, 160)
      : '',
    independentPhone: provenanceConfirmed
      ? (ind.independentPhone || '').trim().slice(0, 40)
      : '',
    independentAddress: provenanceConfirmed
      ? (ind.independentAddress || '').trim().slice(0, 200)
      : '',
    district: (ind.district || '').trim().slice(0, 120),
    independentWebsite: provenanceConfirmed
      ? (ind.independentWebsite || '').trim().slice(0, 300)
      : '',
    independentEmail: provenanceConfirmed
      ? (ind.independentEmail || '').trim().slice(0, 160)
      : '',
    independentCategory: (ind.independentCategory || '').trim().slice(0, 120),
    confirmedNoWebsite: Boolean(ind.confirmedNoWebsite),
    legalBasis: (ind.legalBasis || '').trim().slice(0, 300),
    independentDataProvenance: effectiveProvenance,
    promotedToCrmId: (entry.promotedToCrmId || '').trim().slice(0, 160),
    createdAt: ts,
    updatedAt: ts,
  };
}

function mapTemporaryWorkSnapshotDoc(
  d: QueryDocumentSnapshot<DocumentData> | DocumentSnapshot<DocumentData>,
  uid: string
): PersistedTemporaryWorkItem {
  const data = d.data() || {};
  const outcome: TemporaryQueueOutcome = ALLOWED_TEMPORARY_OUTCOMES.has(data.outcome)
    ? data.outcome
    : 'pendiente';
  const priorityLabel: TemporaryQueuePriority = ALLOWED_TEMPORARY_PRIORITIES.has(data.priorityLabel)
    ? data.priorityLabel
    : 'normal';
  const ttlHours: TemporaryQueueTtlHours = data.ttlHours === 12 ? 12 : 24;

  return {
    id: d.id,
    ownerUid: String(data.ownerUid || uid),
    placeId: String(data.placeId || d.id),
    outcome,
    notes: String(data.notes || ''),
    followUpDate: String(data.followUpDate || ''),
    isSelected: Boolean(data.isSelected),
    priorityLabel,
    ttlHours,
    expiresAtEpochMs: Number(data.expiresAtEpochMs || 0),
    searchCategory: String(data.searchCategory || ''),
    searchDistrict: String(data.searchDistrict || ''),
    provenanceConfirmed: Boolean(data.provenanceConfirmed),
    independentBusinessName: String(data.independentBusinessName || ''),
    independentPhone: String(data.independentPhone || ''),
    independentAddress: String(data.independentAddress || ''),
    district: String(data.district || ''),
    independentWebsite: String(data.independentWebsite || ''),
    independentEmail: String(data.independentEmail || ''),
    independentCategory: String(data.independentCategory || ''),
    confirmedNoWebsite: Boolean(data.confirmedNoWebsite),
    legalBasis: String(data.legalBasis || ''),
    independentDataProvenance: String(data.independentDataProvenance || ''),
    promotedToCrmId: String(data.promotedToCrmId || ''),
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
  };
}

/**
 * Sincroniza de forma idempotente (sin duplicados y sin tocar CRM definitivo) elementos permitidos
 * de la cola temporal hacia /users/{uid}/temporary_work_queue.
 */
export async function upsertTemporaryWorkItemsBatch(
  uid: string,
  entries: TemporaryQueueEntry[],
  ttlHours: TemporaryQueueTtlHours = 24
): Promise<number> {
  if (!uid || entries.length === 0) return 0;
  const collectionPath = getTemporaryWorkQueueCollectionPath(uid);
  let synced = 0;

  for (const entry of entries) {
    const cleanId = sanitizeFirestoreId(entry.placeId);
    if (!cleanId) continue;
    const docPath = `${collectionPath}/${cleanId}`;
    const ref = doc(db, docPath);
    const fullPayload = buildTemporaryWorkItemPayload(uid, entry, ttlHours);

    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) {
          tx.set(ref, fullPayload);
        } else {
          const { ownerUid: _o, placeId: _p, createdAt: _c, ...updateFields } = fullPayload;
          tx.update(ref, updateFields);
        }
      });
      synced += 1;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, docPath);
    }
  }

  return synced;
}

/**
 * Recupera los ítems vigentes (< 12h o < 24h) de la cola temporal desde Firestore al volver a iniciar
 * o recargar la vista previa, devolviendo también los IDs expirados. 0 llamadas a Google Places.
 */
export async function fetchActiveTemporaryWorkQueue(
  uid: string,
  nowMs: number = Date.now()
): Promise<{
  activeItems: PersistedTemporaryWorkItem[];
  expiredPlaceIds: string[];
}> {
  const path = getTemporaryWorkQueueCollectionPath(uid);
  try {
    const q = query(collection(db, path), where('ownerUid', '==', uid));
    const snapshot = await getDocsFromServer(q);
    const activeItems: PersistedTemporaryWorkItem[] = [];
    const expiredPlaceIds: string[] = [];

    for (const d of snapshot.docs) {
      const mapped = mapTemporaryWorkSnapshotDoc(d, uid);
      if (mapped.expiresAtEpochMs > nowMs) {
        activeItems.push(mapped);
      } else {
        expiredPlaceIds.push(d.id);
      }
    }

    activeItems.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { activeItems, expiredPlaceIds };
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

/**
 * Elimina elementos seleccionados o caducados exclusivamente en /users/{uid}/temporary_work_queue.
 * Jamás modifica followups ni sandbox_followups.
 */
export async function deleteTemporaryWorkItemsBatch(
  uid: string,
  placeIds: string[]
): Promise<number> {
  if (!uid || placeIds.length === 0) return 0;
  const collectionPath = getTemporaryWorkQueueCollectionPath(uid);
  const uniqueIds = Array.from(
    new Set(placeIds.map((id) => sanitizeFirestoreId(id)).filter(Boolean))
  );
  if (uniqueIds.length === 0) return 0;

  let deleted = 0;
  const CHUNK_SIZE = 400;
  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const id of chunk) {
      batch.delete(doc(db, collectionPath, id));
    }
    try {
      await batch.commit();
      deleted += chunk.length;
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, collectionPath);
    }
  }
  return deleted;
}


