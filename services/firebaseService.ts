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
  onSnapshot,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp,
  Timestamp,
  query,
  where,
  orderBy,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import {
  DiscardRecord,
  ExclusionRecord,
  FOLLOWUP_STAGES,
  FollowupLeadRecord,
  FollowupStage,
  QualificationTier,
  WebsiteVerificationStatus,
  PhoneVerificationStage,
} from '../types';
import { ParsedExclusionCandidate } from '../utils/exclusionUtils';
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

export function subscribeUserFollowups(
  uid: string,
  onData: (items: FollowupLeadRecord[]) => void,
  onError: (msg: string) => void
): () => void {
  const path = `users/${uid}/followups`;
  const q = query(
    collection(db, path),
    where('ownerUid', '==', uid),
    orderBy('updatedAt', 'desc')
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const items: FollowupLeadRecord[] = snapshot.docs.map((d) => {
        const data = d.data();
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
          stage: normalizeStage(data.stage),
          legalBasis: String(data.legalBasis || ''),
          qualificationTier: (data.qualificationTier || '') as QualificationTier | '',
          aiSummary: String(data.aiSummary || ''),
          notes: String(data.notes || ''),
          createdAt: toIsoString(data.createdAt),
          updatedAt: toIsoString(data.updatedAt),
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

export async function createFollowupRecord(
  uid: string,
  payload: Omit<FollowupLeadRecord, 'id' | 'ownerUid' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const gateError = validateLegalBasisForStage(payload.stage, payload.legalBasis);
  if (gateError) {
    throw new Error(gateError);
  }

  const safeId = sanitizeFirestoreId(
    payload.placeId ? `lead_${payload.placeId}` : `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  );
  const path = `users/${uid}/followups/${safeId}`;
  try {
    await setDoc(doc(db, path), {
      ownerUid: uid,
      placeId: sanitizeFirestoreId(payload.placeId || safeId),
      sourceKind: payload.sourceKind,
      independentBusinessName: payload.independentBusinessName.trim().slice(0, 160),
      district: payload.district.trim().slice(0, 120),
      confirmedNoWebsite: Boolean(payload.confirmedNoWebsite),
      independentWebsiteStatus: payload.independentWebsiteStatus,
      independentPhone: payload.independentPhone.trim().slice(0, 40),
      phoneStage: payload.phoneStage,
      independentEmail: payload.independentEmail.trim().slice(0, 160),
      independentDigitalScore: Math.max(0, Math.min(100, Math.round(payload.independentDigitalScore))),
      independentContactScore: Math.max(0, Math.min(100, Math.round(payload.independentContactScore))),
      stage: payload.stage,
      legalBasis: (payload.legalBasis || '').trim().slice(0, 300),
      qualificationTier: payload.qualificationTier || '',
      aiSummary: (payload.aiSummary || '').trim().slice(0, 800),
      notes: payload.notes.trim().slice(0, 1000),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return safeId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

/**
 * Transfiere en lote leads preseleccionados guardando ÚNICAMENTE Place ID y metadatos propios permitidos
 * (sin persistir nombres, direcciones ni teléfonos procedentes de Google Maps).
 * Evita duplicar registros existentes en Followup.
 */
export async function createBatchPreselectedFollowups(
  uid: string,
  items: Array<{
    placeId: string;
    confirmedNoWebsite: boolean;
    independentWebsiteStatus: WebsiteVerificationStatus;
    phoneStage: PhoneVerificationStage;
    independentDigitalScore: number;
    independentContactScore: number;
    stage: 'PRESELECCIONADO' | 'PENDIENTE DE VERIFICACIÓN';
    qualificationTier: QualificationTier;
    aiSummary: string;
    notes: string;
  }>,
  existingPlaceIds: Set<string>
): Promise<{ created: number; skippedDuplicates: number }> {
  const toCreate = items.filter((item) => item.placeId && !existingPlaceIds.has(item.placeId));
  const skippedDuplicates = items.length - toCreate.length;
  if (toCreate.length === 0) {
    return { created: 0, skippedDuplicates };
  }

  const path = `users/${uid}/followups`;
  const CHUNK_SIZE = 400;
  let created = 0;

  for (let i = 0; i < toCreate.length; i += CHUNK_SIZE) {
    const slice = toCreate.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);

    for (const item of slice) {
      const cleanPlaceId = sanitizeFirestoreId(item.placeId);
      const docId = sanitizeFirestoreId(`lead_${cleanPlaceId}`);
      const ref = doc(db, path, docId);
      batch.set(ref, {
        ownerUid: uid,
        placeId: cleanPlaceId,
        sourceKind: 'places_preselection',
        independentBusinessName: '',
        district: '',
        confirmedNoWebsite: Boolean(item.confirmedNoWebsite),
        independentWebsiteStatus: item.independentWebsiteStatus,
        independentPhone: '',
        phoneStage: item.phoneStage,
        independentEmail: '',
        independentDigitalScore: Math.max(0, Math.min(100, Math.round(item.independentDigitalScore))),
        independentContactScore: Math.max(0, Math.min(100, Math.round(item.independentContactScore))),
        stage: item.stage,
        legalBasis: '',
        qualificationTier: item.qualificationTier,
        aiSummary: (item.aiSummary || '').trim().slice(0, 800),
        notes: (item.notes || '').trim().slice(0, 1000),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    try {
      await batch.commit();
      created += slice.length;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }

  return { created, skippedDuplicates };
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
      | 'phoneStage'
      | 'independentEmail'
      | 'independentDigitalScore'
      | 'independentContactScore'
      | 'stage'
      | 'legalBasis'
      | 'qualificationTier'
      | 'aiSummary'
      | 'notes'
    >
  >,
  currentRecord?: FollowupLeadRecord
): Promise<void> {
  if (typeof updates.stage === 'string') {
    const effectiveLegalBasis =
      typeof updates.legalBasis === 'string'
        ? updates.legalBasis
        : currentRecord?.legalBasis || '';
    const gateError = validateLegalBasisForStage(updates.stage, effectiveLegalBasis);
    if (gateError) {
      throw new Error(gateError);
    }
  }

  const safeId = sanitizeFirestoreId(followupId);
  const path = `users/${uid}/followups/${safeId}`;
  const cleanPayload: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  };

  if (typeof updates.independentBusinessName === 'string') {
    cleanPayload.independentBusinessName = updates.independentBusinessName.trim().slice(0, 160);
  }
  if (typeof updates.district === 'string') {
    cleanPayload.district = updates.district.trim().slice(0, 120);
  }
  if (typeof updates.confirmedNoWebsite === 'boolean') {
    cleanPayload.confirmedNoWebsite = updates.confirmedNoWebsite;
  }
  if (typeof updates.independentWebsiteStatus === 'string') {
    cleanPayload.independentWebsiteStatus = updates.independentWebsiteStatus;
  }
  if (typeof updates.independentPhone === 'string') {
    cleanPayload.independentPhone = updates.independentPhone.trim().slice(0, 40);
  }
  if (typeof updates.phoneStage === 'string') {
    cleanPayload.phoneStage = updates.phoneStage;
  }
  if (typeof updates.independentEmail === 'string') {
    cleanPayload.independentEmail = updates.independentEmail.trim().slice(0, 160);
  }
  if (typeof updates.independentDigitalScore === 'number') {
    cleanPayload.independentDigitalScore = Math.max(0, Math.min(100, Math.round(updates.independentDigitalScore)));
  }
  if (typeof updates.independentContactScore === 'number') {
    cleanPayload.independentContactScore = Math.max(0, Math.min(100, Math.round(updates.independentContactScore)));
  }
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

  try {
    await updateDoc(doc(db, path), cleanPayload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
