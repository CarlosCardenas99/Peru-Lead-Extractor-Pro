import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  ExternalLink,
  Eye,
  Globe,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  AUTHORIZED_OUTREACH_STAGES,
  COMMERCIAL_OUTCOME_OPTIONS,
  CommercialOutcomeType,
  CrmWorkspaceMode,
  FOLLOWUP_STAGES,
  FollowupIntegrityReport,
  FollowupLeadRecord,
  FollowupStage,
  IndependentFieldSource,
  MissingDataResearchResult,
  PhoneVerificationStage,
  PlaceHydrationEntry,
  PlacesQuotaBlockState,
  QuotaStatus,
  ResearchableFieldKey,
  TemporaryQueueEntry,
  TemporaryQueueIndependentDraft,
  TemporaryQueueOutcome,
  TemporaryQueuePriority,
  TemporaryQueueTtlHours,
} from '../types';
import {
  BatchDeleteFollowupsResult,
  BatchDeleteProgress,
  buildSafeLegacyCleanupPreview,
  MissingFieldRecoveryProposal,
  UpdateFollowupOutcome,
} from '../services/firebaseService';
import { researchMissingLeadDataBatch } from '../services/geminiService';
import {
  formatPhoneLineTypeLabel,
  getHydrationStatusMeta,
  isHydrationEntryUsable,
  resolveFollowupPhoneDisplay,
} from '../utils/followupHydration';
import { getPhoneStageLabel } from '../utils/peruPhone';
import { validateLegalBasisForStage } from '../utils/leadQualifier';
import {
  buildPersistedVerificationReport,
  encodeVerificationProvenanceEntry,
  evaluateFollowupCompleteness,
  evaluateFourStagePipelineStatus,
  formatIndependentSourceLabel,
  getCommercialOutcomeLabel,
  getFieldClassificationMeta,
  mergeVerificationSources,
  parseOutcomeHistoryEntry,
  parseVerificationProvenanceEntry,
  PersistedVerificationReport,
  resolveIndependentWebsiteStatusForSave,
} from '../utils/fieldCompliance';
import { computeOutcomeCalibrationStats } from '../utils/scoring';
import { ExportButton } from './ExportButton';
import { FollowupRecoveryModal } from './FollowupRecoveryModal';
import { Pagination } from './Pagination';
import { TemporaryQueueView } from './TemporaryQueueView';

const CRM_ITEMS_PER_PAGE = 10;

interface FollowupCrmViewProps {
  isSignedIn: boolean;
  followups: FollowupLeadRecord[];
  workspaceMode?: CrmWorkspaceMode;
  onChangeWorkspaceMode?: (mode: CrmWorkspaceMode) => void;
  productionCount?: number;
  exclusionPlaceIds?: Set<string>;
  hydrationCache: Record<string, PlaceHydrationEntry>;
  placesQuotaBlock: PlacesQuotaBlockState;
  quota: QuotaStatus | null;
  onHydratePlaceIds?: (
    placeIds: string[],
    options?: { isManualRetry?: boolean; maxBatchSize?: number }
  ) => Promise<void>;
  onRecoverMissingFields?: (
    proposals: MissingFieldRecoveryProposal[]
  ) => Promise<{
    updatedRecords: number;
    skippedRecords: number;
    fieldsCompleted: number;
    verifiedRecords?: FollowupLeadRecord[];
  }>;
  onFetchIntegrityBackup: () => Promise<FollowupIntegrityReport>;
  onSignIn: () => void;
  onUpdateFollowup: (
    id: string,
    updates: Partial<
      Pick<
        FollowupLeadRecord,
        | 'independentBusinessName'
        | 'district'
        | 'independentAddress'
        | 'independentWebsite'
        | 'independentWebsiteStatus'
        | 'independentCategory'
        | 'stage'
        | 'legalBasis'
        | 'phoneStage'
        | 'independentPhone'
        | 'independentEmail'
        | 'independentTrustScore'
        | 'completenessStatus'
        | 'commercialOutcome'
        | 'outcomeSource'
        | 'outcomeContext'
        | 'outcomeRecordedAt'
        | 'outcomeHistory'
        | 'notes'
        | 'confirmedNoWebsite'
        | 'verificationSummary'
        | 'lastVerifiedAt'
        | 'verificationSources'
      >
    >,
    currentRecord?: FollowupLeadRecord
  ) => Promise<UpdateFollowupOutcome | void>;
  onCreateManualFollowup: (payload: {
    independentBusinessName: string;
    district: string;
    independentAddress: string;
    independentWebsite: string;
    independentCategory: string;
    confirmedNoWebsite: boolean;
    independentPhone: string;
    phoneStage: PhoneVerificationStage;
    independentEmail: string;
    legalBasis: string;
    notes: string;
  }) => Promise<void>;
  // Cola Temporal de Sesión + Recuperación 12h/24h — opcional para compatibilidad retroactiva
  temporaryQueue?: TemporaryQueueEntry[];
  subView?: 'temporal' | 'crm';
  onChangeSubView?: (view: 'temporal' | 'crm') => void;
  temporaryTtlHours?: TemporaryQueueTtlHours;
  onChangeTemporaryTtlHours?: (hours: TemporaryQueueTtlHours) => void;
  isSyncingTemporaryQueue?: boolean;
  temporaryRestorationNotice?: string | null;
  onDismissTemporaryRestorationNotice?: () => void;
  onUpdateTemporaryEntry?: (
    placeId: string,
    patch: Partial<{
      outcome: TemporaryQueueOutcome;
      notes: string;
      followUpDate: string;
      priorityLabel: TemporaryQueuePriority;
      isSelected: boolean;
      independentData: Partial<TemporaryQueueIndependentDraft>;
    }>
  ) => void;
  onRemoveTemporarySelected?: (placeIds: string[]) => void;
  onClearTemporaryQueue?: () => void;
  onPromoteTemporaryEntry?: (entry: TemporaryQueueEntry) => Promise<string | null>;
  onGoToExplorer?: () => void;
  // Borrado controlado en Firestore (Fase 3)
  onDeleteFollowupsBatch?: (
    docIds: string[],
    options: {
      backupVerified: boolean;
      onProgress?: (progress: BatchDeleteProgress) => void;
    }
  ) => Promise<BatchDeleteFollowupsResult>;
}

export const FollowupCrmView: React.FC<FollowupCrmViewProps> = ({
  isSignedIn,
  followups,
  workspaceMode = 'production',
  onChangeWorkspaceMode,
  productionCount,
  exclusionPlaceIds,
  hydrationCache,
  placesQuotaBlock,
  quota,
  onRecoverMissingFields,
  onFetchIntegrityBackup,
  onSignIn,
  onUpdateFollowup,
  onCreateManualFollowup,
  temporaryQueue,
  subView: controlledSubView,
  onChangeSubView,
  temporaryTtlHours = 24,
  onChangeTemporaryTtlHours,
  isSyncingTemporaryQueue = false,
  temporaryRestorationNotice = null,
  onDismissTemporaryRestorationNotice,
  onUpdateTemporaryEntry,
  onRemoveTemporarySelected,
  onClearTemporaryQueue,
  onPromoteTemporaryEntry,
  onGoToExplorer,
  onDeleteFollowupsBatch,
}) => {
  const hasTemporaryQueueSupport = Array.isArray(temporaryQueue);
  const [internalSubView, setInternalSubView] = useState<'temporal' | 'crm'>(
    hasTemporaryQueueSupport ? 'temporal' : 'crm'
  );
  const subView = controlledSubView ?? internalSubView;
  const setSubView = (next: 'temporal' | 'crm') => {
    setInternalSubView(next);
    onChangeSubView?.(next);
  };
  const [stageFilter, setStageFilter] = useState<'all' | FollowupStage>('all');
  const [queueFilter, setQueueFilter] = useState<'all' | 'complete_only' | 'incomplete_queue'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openedRecordId, setOpenedRecordId] = useState<string | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [showCalibrationPanel, setShowCalibrationPanel] = useState(false);
  const [showCleanupPreviewPanel, setShowCleanupPreviewPanel] = useState(false);

  // Fase 3: selección y borrado controlado de registros persistidos en Firestore
  const [selectedFollowupIds, setSelectedFollowupIds] = useState<Set<string>>(new Set());
  const [deleteDialogState, setDeleteDialogState] = useState<{
    mode: 'selected' | 'all';
    docIds: string[];
    typedConfirmation: string;
    backupDownloading: boolean;
    backupDownloaded: boolean;
    error: string | null;
  } | null>(null);
  const [isDeletingBatch, setIsDeletingBatch] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<BatchDeleteProgress | null>(null);
  const [deleteResultReport, setDeleteResultReport] =
    useState<BatchDeleteFollowupsResult | null>(null);

  const [outcomeDraftType, setOutcomeDraftType] = useState<CommercialOutcomeType>('none');
  const [outcomeDraftSource, setOutcomeDraftSource] = useState('llamada_directa_webnex');
  const [outcomeDraftContext, setOutcomeDraftContext] = useState('');
  const [savingOutcome, setSavingOutcome] = useState(false);

  const [draftName, setDraftName] = useState('');
  const [draftCategory, setDraftCategory] = useState('');
  const [draftAddress, setDraftAddress] = useState('');
  const [draftDistrict, setDraftDistrict] = useState('');
  const [draftWebsite, setDraftWebsite] = useState('');
  const [draftPhone, setDraftPhone] = useState('');
  const [draftEmail, setDraftEmail] = useState('');
  const [draftLegalBasis, setDraftLegalBasis] = useState('');
  const [draftNotes, setDraftNotes] = useState('');

  // Pending authorization prompt when user selects CONTACTO AUTORIZADO / CONTACTADO without legalBasis
  const [authPrompt, setAuthPrompt] = useState<{
    record: FollowupLeadRecord;
    targetStage: FollowupStage;
    legalBasisInput: string;
    error: string | null;
  } | null>(null);

  const [showManualForm, setShowManualForm] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualCategory, setManualCategory] = useState('');
  const [manualAddress, setManualAddress] = useState('');
  const [manualDistrict, setManualDistrict] = useState('');
  const [manualWebsite, setManualWebsite] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [manualConfirmedNoWeb, setManualConfirmedNoWeb] = useState(true);
  const [manualNotes, setManualNotes] = useState('');

  // Integrity verification & JSON backup state (non-destructive)
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupReport, setBackupReport] = useState<FollowupIntegrityReport | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  // Server readback verification banner & partial safe repair inside opened record modal
  const [serverVerificationNotice, setServerVerificationNotice] = useState<{
    docId: string;
    report: PersistedVerificationReport;
  } | null>(null);

  const openedRecordInitializedIdRef = useRef<string | null>(null);
  const [repairName, setRepairName] = useState('');
  const [repairAddress, setRepairAddress] = useState('');
  const [repairWebsite, setRepairWebsite] = useState('');
  const [repairPhone, setRepairPhone] = useState('');
  const [repairDistrict, setRepairDistrict] = useState('');
  const [repairEmail, setRepairEmail] = useState('');
  const [repairCategory, setRepairCategory] = useState('');
  const [repairSocialUrl, setRepairSocialUrl] = useState('');
  const [repairEvidenceText, setRepairEvidenceText] = useState('');
  const [repairResearchResult, setRepairResearchResult] = useState<MissingDataResearchResult | null>(null);
  const [repairSource, setRepairSource] = useState<IndependentFieldSource>('user_manual_entry');
  const [repairConfirmed, setRepairConfirmed] = useState(false);
  const [repairCorroborating, setRepairCorroborating] = useState(false);
  const [repairSaving, setRepairSaving] = useState(false);
  const [repairFeedback, setRepairFeedback] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return followups.filter((item) => {
      if (stageFilter !== 'all' && item.stage !== stageFilter) return false;
      if (queueFilter !== 'all') {
        const comp = evaluateFollowupCompleteness(item);
        if (queueFilter === 'complete_only' && comp.isFichaIncompleta) return false;
        if (queueFilter === 'incomplete_queue' && !comp.isFichaIncompleta) return false;
      }
      if (!q) return true;
      const entry = hydrationCache[item.placeId];
      const hydrated = isHydrationEntryUsable(entry) ? entry.details : null;
      return (
        item.independentBusinessName.toLowerCase().includes(q) ||
        (item.independentAddress || '').toLowerCase().includes(q) ||
        (item.independentWebsite || '').toLowerCase().includes(q) ||
        (item.independentCategory || '').toLowerCase().includes(q) ||
        item.district.toLowerCase().includes(q) ||
        item.independentPhone.toLowerCase().includes(q) ||
        item.placeId.toLowerCase().includes(q) ||
        item.notes.toLowerCase().includes(q) ||
        (hydrated?.displayName || '').toLowerCase().includes(q) ||
        (hydrated?.formattedAddress || '').toLowerCase().includes(q)
      );
    });
  }, [followups, stageFilter, queueFilter, searchTerm, hydrationCache]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / CRM_ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  useEffect(() => {
    if (currentPage !== safePage) {
      setCurrentPage(safePage);
    }
  }, [currentPage, safePage]);

  const paginatedFollowups = useMemo(() => {
    const start = (safePage - 1) * CRM_ITEMS_PER_PAGE;
    return filtered.slice(start, start + CRM_ITEMS_PER_PAGE);
  }, [filtered, safePage]);

  const liveCounts = useMemo(() => {
    const uniqueDocIds = new Set(followups.map((f) => f.id)).size;
    const uniquePlaceIds = new Set(followups.map((f) => f.placeId).filter(Boolean)).size;
    let completeCount = 0;
    let incompleteCount = 0;
    for (const f of followups) {
      if (evaluateFollowupCompleteness(f).status === 'complete') {
        completeCount += 1;
      } else {
        incompleteCount += 1;
      }
    }
    return {
      totalDocuments: followups.length,
      uniqueDocIds,
      uniquePlaceIds,
      completeCount,
      incompleteCount,
    };
  }, [followups]);

  const calibrationStats = useMemo(
    () => computeOutcomeCalibrationStats(followups),
    [followups]
  );

  const cleanupPreview = useMemo(() => {
    if (!showCleanupPreviewPanel) return null;
    return buildSafeLegacyCleanupPreview(followups, {
      backupVerified: Boolean(backupReport),
      exclusionPlaceIds: exclusionPlaceIds || new Set<string>(),
    });
  }, [showCleanupPreviewPanel, followups, backupReport, exclusionPlaceIds]);

  const openedRecord = useMemo(
    () => (openedRecordId ? followups.find((f) => f.id === openedRecordId) || null : null),
    [followups, openedRecordId]
  );

  useEffect(() => {
    if (!openedRecord) {
      openedRecordInitializedIdRef.current = null;
      return;
    }
    setOutcomeDraftType(openedRecord.commercialOutcome || 'none');
    setOutcomeDraftSource(openedRecord.outcomeSource || 'llamada_directa_webnex');
    setOutcomeDraftContext(openedRecord.outcomeContext || '');

    if (openedRecordInitializedIdRef.current !== openedRecord.id) {
      openedRecordInitializedIdRef.current = openedRecord.id;
      setRepairName('');
      setRepairAddress('');
      setRepairWebsite('');
      setRepairPhone('');
      setRepairDistrict('');
      setRepairEmail('');
      setRepairCategory('');
      setRepairSocialUrl('');
      setRepairEvidenceText('');
      setRepairResearchResult(null);
      setRepairSource('user_manual_entry');
      setRepairConfirmed(false);
      setRepairFeedback(null);
    }
  }, [openedRecord]);

  const triggerJsonBackupDownload = async (): Promise<FollowupIntegrityReport> => {
    setIsBackingUp(true);
    setBackupError(null);
    try {
      const report = await onFetchIntegrityBackup();
      setBackupReport(report);

      const backupPayload = {
        exportedFrom: `WEBNEX SYSTEMS - Seguimiento Firestore (${workspaceMode})`,
        backedUpAt: report.backedUpAt,
        integritySummary: {
          totalDocuments: report.totalDocuments,
          uniqueDocIds: report.uniqueDocIds,
          uniquePlaceIds: report.uniquePlaceIds,
        },
        records: report.records,
      };
      const blob = new Blob([JSON.stringify(backupPayload, null, 2)], {
        type: 'application/json;charset=utf-8;',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `webnex_respaldo_${workspaceMode}_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return report;
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleOpenRecord = (item: FollowupLeadRecord) => {
    setOpenedRecordId(item.id);
  };

  const handleDownloadIntegrityBackup = async () => {
    try {
      await triggerJsonBackupDownload();
    } catch (err: any) {
      setBackupError(err?.message || 'No se pudo generar el respaldo JSON desde Firestore.');
    }
  };

  const renderSubViewSwitcher = () =>
    hasTemporaryQueueSupport ? (
      <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSubView('temporal')}
            className={`px-3.5 py-2 text-xs font-semibold rounded-lg border transition-colors ${
              subView === 'temporal'
                ? 'bg-purple-700 text-white border-purple-700'
                : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
            }`}
          >
            Cola Temporal de Sesión ({temporaryQueue!.length})
          </button>
          <button
            type="button"
            onClick={() => setSubView('crm')}
            className={`px-3.5 py-2 text-xs font-semibold rounded-lg border transition-colors ${
              subView === 'crm'
                ? 'bg-purple-700 text-white border-purple-700'
                : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
            }`}
          >
            CRM Definitivo Firestore ({followups.length})
          </button>
        </div>
        <div className="text-[11px] text-slate-500 px-2">
          {subView === 'temporal'
            ? 'Sesión activa en RAM (0 Places Details)'
            : `Colección Firestore: ${workspaceMode === 'sandbox' ? 'sandbox_followups' : 'followups'}`}
        </div>
      </div>
    ) : null;

  if (hasTemporaryQueueSupport && subView === 'temporal') {
    return (
      <div className="space-y-4">
        {renderSubViewSwitcher()}
        <TemporaryQueueView
          queue={temporaryQueue!}
          isSignedIn={isSignedIn}
          workspaceMode={workspaceMode}
          onChangeWorkspaceMode={(mode) => {
            onChangeWorkspaceMode?.(mode);
          }}
          ttlHours={temporaryTtlHours}
          onChangeTtlHours={onChangeTemporaryTtlHours}
          isSyncingPersistence={isSyncingTemporaryQueue}
          restorationNotice={temporaryRestorationNotice}
          onDismissRestorationNotice={onDismissTemporaryRestorationNotice}
          onUpdateEntry={(placeId, patch) => onUpdateTemporaryEntry?.(placeId, patch)}
          onRemoveSelected={(placeIds) => onRemoveTemporarySelected?.(placeIds)}
          onClearAll={() => onClearTemporaryQueue?.()}
          onPromoteToCrm={async (entry) => {
            if (!onPromoteTemporaryEntry) return null;
            return onPromoteTemporaryEntry(entry);
          }}
          onGoToExplorer={() => onGoToExplorer?.()}
        />
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="space-y-4">
        {renderSubViewSwitcher()}
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <h2 className="text-lg font-semibold text-slate-900">
            CRM Definitivo Privado (Firebase Firestore)
          </h2>
          <p className="text-sm text-slate-600 mt-2 max-w-lg mx-auto">
            Inicia sesión con Google para gestionar o limpiar tus fichas comerciales persistentes en Firestore bajo reglas estrictas por UID autorizado.
          </p>
          <button
            type="button"
            onClick={onSignIn}
            className="mt-5 px-5 py-2.5 text-sm font-semibold bg-purple-700 text-white rounded-lg hover:bg-purple-800 transition-colors"
          >
            Iniciar sesión con Google
          </button>
        </div>
      </div>
    );
  }

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualName.trim()) return;
    await onCreateManualFollowup({
      independentBusinessName: manualName.trim(),
      district: manualDistrict.trim(),
      independentAddress: manualAddress.trim(),
      independentWebsite: manualWebsite.trim(),
      independentCategory: manualCategory.trim(),
      confirmedNoWebsite: manualConfirmedNoWeb,
      independentPhone: manualPhone.trim(),
      phoneStage: manualPhone.trim() ? 'independently_corroborated' : 'none',
      independentEmail: manualEmail.trim(),
      legalBasis: '',
      notes: manualNotes.trim(),
    });
    setManualName('');
    setManualCategory('');
    setManualAddress('');
    setManualDistrict('');
    setManualWebsite('');
    setManualPhone('');
    setManualEmail('');
    setManualNotes('');
    setShowManualForm(false);
  };

  const handleStageChange = async (item: FollowupLeadRecord, nextStage: FollowupStage) => {
    if (AUTHORIZED_OUTREACH_STAGES.has(nextStage)) {
      const gateError = validateLegalBasisForStage(nextStage, item.legalBasis);
      if (gateError) {
        setAuthPrompt({
          record: item,
          targetStage: nextStage,
          legalBasisInput: item.legalBasis || '',
          error: null,
        });
        return;
      }
    }
    await onUpdateFollowup(item.id, { stage: nextStage }, item);
  };

  const expectedTypedConfirm =
    workspaceMode === 'sandbox' ? 'ELIMINAR SANDBOX' : 'ELIMINAR PRODUCCION';

  const startControlledFirestoreDelete = async (mode: 'selected' | 'all') => {
    const targetIds =
      mode === 'all'
        ? followups.map((f) => f.id)
        : followups.filter((f) => selectedFollowupIds.has(f.id)).map((f) => f.id);

    if (targetIds.length === 0) return;

    setDeleteResultReport(null);
    setDeleteProgress(null);
    setDeleteDialogState({
      mode,
      docIds: targetIds,
      typedConfirmation: '',
      backupDownloading: true,
      backupDownloaded: false,
      error: null,
    });

    try {
      await triggerJsonBackupDownload();
      setDeleteDialogState((prev) =>
        prev
          ? {
              ...prev,
              backupDownloading: false,
              backupDownloaded: true,
            }
          : null
      );
    } catch (err: any) {
      setDeleteDialogState((prev) =>
        prev
          ? {
              ...prev,
              backupDownloading: false,
              backupDownloaded: false,
              error:
                err?.message ||
                'No se pudo descargar el respaldo JSON obligatorio; el borrado permanece bloqueado.',
            }
          : null
      );
    }
  };

  const executeConfirmedFirestoreDelete = async () => {
    if (!deleteDialogState || !onDeleteFollowupsBatch) return;
    if (!deleteDialogState.backupDownloaded) return;
    if (
      deleteDialogState.mode === 'all' &&
      deleteDialogState.typedConfirmation.trim() !== expectedTypedConfirm
    ) {
      setDeleteDialogState((prev) =>
        prev
          ? {
              ...prev,
              error: `Escribe exactamente "${expectedTypedConfirm}" para confirmar la limpieza total.`,
            }
          : null
      );
      return;
    }

    setIsDeletingBatch(true);
    setDeleteDialogState((prev) => (prev ? { ...prev, error: null } : null));
    setDeleteProgress({
      processed: 0,
      total: deleteDialogState.docIds.length,
      deleted: 0,
      failed: 0,
    });

    try {
      const result = await onDeleteFollowupsBatch(deleteDialogState.docIds, {
        backupVerified: true,
        onProgress: (prog) => setDeleteProgress(prog),
      });
      setDeleteResultReport(result);
      setSelectedFollowupIds((prev) => {
        const next = new Set(prev);
        for (const id of result.deletedIds) next.delete(id);
        return next;
      });
      setDeleteDialogState(null);
    } catch (err: any) {
      setDeleteDialogState((prev) =>
        prev
          ? {
              ...prev,
              error: err?.message || 'Ocurrió un error al eliminar registros en Firestore.',
            }
          : null
      );
    } finally {
      setIsDeletingBatch(false);
    }
  };

  const visibleSelectedCount = paginatedFollowups.filter((f) =>
    selectedFollowupIds.has(f.id)
  ).length;
  const allVisibleFollowupsSelected =
    paginatedFollowups.length > 0 && visibleSelectedCount === paginatedFollowups.length;

  return (
    <div className="space-y-4">
      {renderSubViewSwitcher()}
      {onChangeWorkspaceMode && (
        <div
          className={`rounded-xl border px-4 py-3 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs ${
            workspaceMode === 'sandbox'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
              : 'bg-white border-slate-200 text-slate-800'
          }`}
        >
          <div>
            <div className="font-semibold">
              {workspaceMode === 'sandbox'
                ? 'Modo activo: Espacio Aislado de Pruebas (Fase 7 · Sandbox)'
                : 'Modo activo: CRM Producción'}
            </div>
            <div className="text-[11px] opacity-85 mt-0.5">
              {workspaceMode === 'sandbox'
                ? 'Opera sobre users/{uid}/sandbox_followups. Los 52 registros de producción permanecen 100% intactos.'
                : 'Lee y actualiza users/{uid}/followups directamente desde Firestore sin consumir cuota Places.'}
            </div>
          </div>
          <div className="inline-flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                onChangeWorkspaceMode('production');
                setCurrentPage(1);
              }}
              className={`px-3 py-1.5 rounded-lg border text-xs font-medium ${
                workspaceMode === 'production'
                  ? 'bg-purple-700 text-white border-purple-700'
                  : 'bg-white text-slate-700 border-slate-300'
              }`}
            >
              Producción ({typeof productionCount === 'number' ? productionCount : followups.length})
            </button>
            <button
              type="button"
              onClick={() => {
                onChangeWorkspaceMode('sandbox');
                setCurrentPage(1);
              }}
              className={`px-3 py-1.5 rounded-lg border text-xs font-medium ${
                workspaceMode === 'sandbox'
                  ? 'bg-emerald-700 text-white border-emerald-700'
                  : 'bg-white text-slate-700 border-slate-300'
              }`}
            >
              Espacio Aislado Pruebas (Sandbox)
            </button>
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Módulo de Seguimiento Comercial (CRM Persistente en Firebase · 0 llamadas Places)
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Todas las fichas se cargan directamente desde Firebase Firestore sin consultar Google Places. Si hay datos en caché temporal de Explorador de esta sesión, se muestran solo como referencia adicional en pantalla.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isBackingUp}
            onClick={handleDownloadIntegrityBackup}
            className="px-3 py-2 text-xs font-medium border border-purple-300 bg-purple-50 text-purple-800 rounded-lg hover:bg-purple-100 inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <DatabaseBackup className="w-3.5 h-3.5" />
            {isBackingUp ? 'Verificando Firestore...' : 'Respaldo JSON Firestore'}
          </button>

          {onRecoverMissingFields && (
            <button
              type="button"
              onClick={() => setRecoveryOpen(true)}
              className="px-3 py-2 text-xs font-medium border border-emerald-300 bg-emerald-50 text-emerald-900 rounded-lg hover:bg-emerald-100 inline-flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Recuperar fichas incompletas ({liveCounts.incompleteCount})
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowCalibrationPanel((v) => !v)}
            className="px-3 py-2 text-xs font-medium border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50"
          >
            {showCalibrationPanel ? 'Ocultar resultados reales' : 'Resultados reales y calibración'}
          </button>

          {workspaceMode === 'production' && (
            <button
              type="button"
              onClick={() => setShowCleanupPreviewPanel((v) => !v)}
              className="px-3 py-2 text-xs font-medium border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50"
            >
              {showCleanupPreviewPanel ? 'Ocultar vista previa Fase 8' : 'Vista previa Fase 8'}
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowManualForm((v) => !v)}
            className="px-3 py-2 text-xs font-medium border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50"
          >
            {showManualForm ? 'Cerrar registro manual' : 'Agregar registro independiente'}
          </button>
          <ExportButton followups={filtered} />
        </div>
      </div>

      {/* Integridad + completitud de fichas persistentes */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700">
        <div className="flex flex-wrap items-center gap-4 font-mono-tabular">
          <span>
            Registros en CRM: <strong>{liveCounts.totalDocuments}</strong>
          </span>
          <span>
            IDs únicos: <strong>{liveCounts.uniqueDocIds}</strong>
          </span>
          <span>
            Place IDs únicos: <strong>{liveCounts.uniquePlaceIds}</strong>
          </span>
          <span>
            Fichas completas: <strong className="text-emerald-800">{liveCounts.completeCount}</strong>
          </span>
          <span>
            Cola investigación / incompletas: <strong className="text-amber-800">{liveCounts.incompleteCount}</strong>
          </span>
          {quota && (
            <span title="Solo mide llamadas realizadas desde Explorador en esta sesión">
              Consumo Places (Explorador): <strong>{quota.placesUsed}/{quota.placesLimit}</strong>
            </span>
          )}
          {backupReport && (
            <span className="text-emerald-800 font-sans font-medium">
              Verificado en servidor Firestore: {backupReport.totalDocuments} docs / {backupReport.uniquePlaceIds} Place IDs únicos
            </span>
          )}
        </div>
      </div>

      {/* FASE 3: Limpieza controlada de Firestore (Producción y Sandbox) */}
      {onDeleteFollowupsBatch && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="text-xs space-y-0.5">
              <div className="font-semibold text-slate-900">
                Limpieza Controlada de Seguimiento en Firestore ({workspaceMode === 'sandbox' ? 'Sandbox' : 'Producción'})
              </div>
              <p className="text-[11px] text-slate-500">
                Opera solo sobre <span className="font-mono-tabular">{workspaceMode === 'sandbox' ? 'users/{uid}/sandbox_followups' : 'users/{uid}/followups'}</span> ({followups.length} registros). Nunca toca Authentication, exclusiones, descartados ni reglas. Descarga respaldo JSON automáticamente antes de borrar.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={isDeletingBatch || selectedFollowupIds.size === 0}
                onClick={() => startControlledFirestoreDelete('selected')}
                className="px-3 py-1.5 text-xs font-semibold border border-rose-300 bg-rose-50 text-rose-900 rounded-lg hover:bg-rose-100 disabled:opacity-40 inline-flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Respaldar JSON y eliminar seleccionados ({selectedFollowupIds.size})
              </button>
              <button
                type="button"
                disabled={isDeletingBatch || followups.length === 0}
                onClick={() => startControlledFirestoreDelete('all')}
                className="px-3 py-1.5 text-xs font-semibold border border-rose-400 bg-white text-rose-800 rounded-lg hover:bg-rose-50 disabled:opacity-40"
              >
                Limpiar todos los registros ({followups.length})
              </button>
            </div>
          </div>

          {deleteDialogState && (
            <div className="bg-rose-50 border border-rose-300 rounded-xl p-4 space-y-3 text-xs text-rose-950">
              <div className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-rose-700 shrink-0" />
                {deleteDialogState.mode === 'all'
                  ? `Confirmación crítica: eliminar TODOS los ${deleteDialogState.docIds.length} registros de ${workspaceMode === 'sandbox' ? 'Sandbox' : 'Producción'}`
                  : `Confirmar eliminación de ${deleteDialogState.docIds.length} registro(s) seleccionado(s) en ${workspaceMode === 'sandbox' ? 'Sandbox' : 'Producción'}`}
              </div>

              <div className="text-[11px]">
                {deleteDialogState.backupDownloading ? (
                  <span className="font-medium text-purple-900">
                    Generando y descargando respaldo JSON previo desde Firestore...
                  </span>
                ) : deleteDialogState.backupDownloaded ? (
                  <span className="font-semibold text-emerald-800">
                    Respaldo JSON verificado y descargado ({deleteDialogState.docIds.length} doc(s) marcados para borrado).
                  </span>
                ) : (
                  <span className="text-rose-800 font-semibold">
                    No se pudo completar el respaldo JSON previo.
                  </span>
                )}
              </div>

              {deleteDialogState.mode === 'all' && deleteDialogState.backupDownloaded && (
                <div>
                  <label className="block text-[11px] font-medium mb-1">
                    Para confirmar esta limpieza total en Firestore, escribe{' '}
                    <strong className="font-mono-tabular">{expectedTypedConfirm}</strong>:
                  </label>
                  <input
                    type="text"
                    value={deleteDialogState.typedConfirmation}
                    onChange={(e) =>
                      setDeleteDialogState((prev) =>
                        prev ? { ...prev, typedConfirmation: e.target.value, error: null } : null
                      )
                    }
                    placeholder={expectedTypedConfirm}
                    className="w-full sm:w-72 px-3 py-1.5 border border-rose-300 rounded bg-white text-xs font-mono-tabular"
                  />
                </div>
              )}

              {deleteProgress && (
                <div className="space-y-1">
                  <div className="text-[11px] font-mono-tabular">
                    Progreso de borrado: {deleteProgress.processed}/{deleteProgress.total} · Eliminados:{' '}
                    {deleteProgress.deleted} · Errores: {deleteProgress.failed}
                  </div>
                  <div className="w-full bg-rose-200 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-rose-700 h-2 transition-all"
                      style={{
                        width: `${Math.round(
                          (deleteProgress.processed / Math.max(1, deleteProgress.total)) * 100
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {deleteDialogState.error && (
                <div className="text-xs text-rose-800 font-semibold bg-white border border-rose-200 rounded px-2.5 py-1.5">
                  {deleteDialogState.error}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={
                    isDeletingBatch ||
                    deleteDialogState.backupDownloading ||
                    !deleteDialogState.backupDownloaded
                  }
                  onClick={executeConfirmedFirestoreDelete}
                  className="px-3.5 py-1.5 bg-rose-700 text-white font-semibold rounded-lg hover:bg-rose-800 disabled:opacity-40"
                >
                  {isDeletingBatch
                    ? 'Eliminando en Firestore...'
                    : `Ejecutar borrado (${deleteDialogState.docIds.length})`}
                </button>
                <button
                  type="button"
                  disabled={isDeletingBatch}
                  onClick={() => setDeleteDialogState(null)}
                  className="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 rounded-lg"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {deleteResultReport && (
            <div
              className={`rounded-lg border px-3 py-2 text-xs ${
                deleteResultReport.failedItems.length > 0
                  ? 'bg-amber-50 border-amber-300 text-amber-950'
                  : 'bg-emerald-50 border-emerald-300 text-emerald-950'
              }`}
            >
              <div>
                Resultado en <span className="font-mono-tabular">{deleteResultReport.collectionPath}</span>:{' '}
                <strong>{deleteResultReport.deletedIds.length}</strong> eliminado(s) de{' '}
                <strong>{deleteResultReport.totalRequested}</strong> · Errores parciales:{' '}
                <strong>{deleteResultReport.failedItems.length}</strong>.
              </div>
              {deleteResultReport.failedItems.length > 0 && (
                <ul className="mt-1 text-[11px] space-y-0.5">
                  {deleteResultReport.failedItems.slice(0, 5).map((f) => (
                    <li key={f.id}>
                      • {f.id}: {f.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {showCalibrationPanel && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-slate-900">
              FASE 6 — Embudo de Resultados Comerciales Reales y Calibración Determinística
            </h3>
            <span className="text-[11px] font-mono-tabular text-slate-500">
              Umbral mínimo anti-sobreajuste: {calibrationStats.minimumSampleThreshold} contactos alcanzados
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 text-xs">
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-[10px] text-slate-500">Revisados</div>
              <div className="text-base font-semibold font-mono-tabular">{calibrationStats.reviewedCount}</div>
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-[10px] text-slate-500">Corroborados 4/4</div>
              <div className="text-base font-semibold font-mono-tabular">{calibrationStats.corroboratedCount}</div>
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-[10px] text-slate-500">Autorizados legal</div>
              <div className="text-base font-semibold font-mono-tabular">{calibrationStats.legallyAuthorizedCount}</div>
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-[10px] text-slate-500">Alcanzados</div>
              <div className="text-base font-semibold font-mono-tabular">{calibrationStats.reachedCount}</div>
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-[10px] text-slate-500">Respuestas</div>
              <div className="text-base font-semibold font-mono-tabular">{calibrationStats.effectiveResponsesCount}</div>
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-[10px] text-slate-500">Interesados</div>
              <div className="text-base font-semibold font-mono-tabular">{calibrationStats.interestedCount}</div>
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-[10px] text-slate-500">Cotizaciones</div>
              <div className="text-base font-semibold font-mono-tabular">{calibrationStats.quotationsCount}</div>
            </div>
            <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg">
              <div className="text-[10px] text-emerald-800">Ventas conf.</div>
              <div className="text-base font-semibold text-emerald-900 font-mono-tabular">{calibrationStats.confirmedSalesCount}</div>
            </div>
          </div>
          <ul className="text-xs text-slate-700 space-y-1">
            {calibrationStats.insights.map((insight, idx) => (
              <li key={idx}>• {insight}</li>
            ))}
          </ul>
        </div>
      )}

      {showCleanupPreviewPanel && cleanupPreview && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 space-y-2 text-xs text-amber-950">
          <div className="font-semibold">
            FASE 8 — Vista Previa Segura de Limpieza Posterior (SOLO LECTURA · EJECUCIÓN BLOQUEADA)
          </div>
          <p>{cleanupPreview.blockingReason}</p>
          <div className="flex flex-wrap gap-4 font-mono-tabular">
            <span>Total evaluados: <strong>{cleanupPreview.totalRecords}</strong></span>
            <span>Clientes protegidos: <strong>{cleanupPreview.protectedClientesCount}</strong></span>
            <span>Exclusiones protegidas: <strong>{cleanupPreview.protectedExclusionsCount}</strong></span>
            <span>Fichas completas protegidas: <strong>{cleanupPreview.completeRecordsCount}</strong></span>
            <span>Candidatos incompletos para revisión futura: <strong>{cleanupPreview.incompleteCleanupCandidatesCount}</strong></span>
          </div>
        </div>
      )}

      {placesQuotaBlock.blocked && (
        <div
          role="status"
          className="bg-amber-50 border border-amber-300 text-amber-950 rounded-xl p-4 text-xs space-y-1.5"
        >
          <div className="font-semibold flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-amber-800 shrink-0" />
            {placesQuotaBlock.source === 'google_resource_exhausted'
              ? 'Cuota de Google Places API pausada en Explorador (CRM 100% operativo)'
              : 'Límite preventivo local de Explorador alcanzado (CRM 100% operativo)'}
          </div>
          <p className="leading-relaxed">
            Seguimiento funciona directamente con tus datos persistidos en Firebase sin consumir Google Places. Puedes revisar, editar, recuperar desde webs oficiales o exportar tus <strong>{followups.length} fichas</strong> con normalidad.
          </p>
        </div>
      )}

      {backupError && (
        <div className="bg-red-50 border border-red-200 text-red-900 rounded-xl px-4 py-2.5 text-xs">
          {backupError}
        </div>
      )}

      {serverVerificationNotice && (
        <div
          className={`rounded-xl border px-4 py-3 text-xs space-y-1.5 ${
            serverVerificationNotice.report.isComplete
              ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
              : 'bg-amber-50 border-amber-300 text-amber-950'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="font-semibold flex items-center gap-1.5">
              {serverVerificationNotice.report.isComplete ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
              )}
              {serverVerificationNotice.report.isComplete
                ? `Lectura verificada en servidor Firestore (${serverVerificationNotice.docId}): ficha comercial persistente completa.`
                : `Lectura verificada en servidor Firestore (${serverVerificationNotice.docId}): FICHA INCOMPLETA (${serverVerificationNotice.report.status}).`}
            </div>
            <button
              type="button"
              onClick={() => setServerVerificationNotice(null)}
              className="underline text-[11px] shrink-0"
            >
              Cerrar
            </button>
          </div>
          <div className="text-[11px] font-mono-tabular break-words">
            {serverVerificationNotice.report.persistedCoreSummary}
          </div>
          {serverVerificationNotice.report.missingReasons.length > 0 && (
            <ul className="text-[11px] space-y-0.5 pt-1 border-t border-amber-200">
              {serverVerificationNotice.report.missingReasons.map((reason, idx) => (
                <li key={idx}>• {reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {authPrompt && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 space-y-3">
          <div className="flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-amber-800 mt-0.5 shrink-0" />
            <div className="text-xs text-amber-950">
              <div className="font-semibold">
                Autorización de Contacto Requerida para pasar a &ldquo;{authPrompt.targetStage}&rdquo;
              </div>
              <p className="mt-0.5">
                La preselección automática NO autoriza llamadas ni mensajes comerciales. Registra la evidencia verificable de consentimiento previo o base legal aplicable antes de autorizar el contacto.
              </p>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={authPrompt.legalBasisInput}
              onChange={(e) =>
                setAuthPrompt({ ...authPrompt, legalBasisInput: e.target.value, error: null })
              }
              placeholder="Ej: Solicitud recibida por formulario web / Referido directo B2B verificado (mín. 8 caracteres)"
              className="flex-1 px-3 py-2 text-xs border border-amber-300 rounded-lg bg-white"
            />
            <button
              type="button"
              onClick={async () => {
                const err = validateLegalBasisForStage(
                  authPrompt.targetStage,
                  authPrompt.legalBasisInput
                );
                if (err) {
                  setAuthPrompt({ ...authPrompt, error: err });
                  return;
                }
                await onUpdateFollowup(
                  authPrompt.record.id,
                  {
                    stage: authPrompt.targetStage,
                    legalBasis: authPrompt.legalBasisInput.trim(),
                  },
                  authPrompt.record
                );
                setAuthPrompt(null);
              }}
              className="px-4 py-2 text-xs font-semibold bg-purple-700 text-white rounded-lg hover:bg-purple-800 whitespace-nowrap"
            >
              Autorizar y actualizar etapa
            </button>
            <button
              type="button"
              onClick={() => setAuthPrompt(null)}
              className="px-3 py-2 text-xs border border-slate-300 bg-white rounded-lg"
            >
              Cancelar
            </button>
          </div>
          {authPrompt.error && (
            <div className="text-xs text-red-700 font-medium">{authPrompt.error}</div>
          )}
        </div>
      )}

      {showManualForm && (
        <form
          onSubmit={handleManualSubmit}
          className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 md:grid-cols-3 gap-4"
        >
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Nombre comercial (ingresado manualmente)
            </label>
            <input
              type="text"
              required
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Categoría propia
            </label>
            <input
              type="text"
              value={manualCategory}
              onChange={(e) => setManualCategory(e.target.value)}
              placeholder="Ej: Odontología / Ferretería"
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Distrito / Zona
            </label>
            <input
              type="text"
              value={manualDistrict}
              onChange={(e) => setManualDistrict(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Dirección propia
            </label>
            <input
              type="text"
              value={manualAddress}
              onChange={(e) => setManualAddress(e.target.value)}
              placeholder="Av. / Jr. / Calle"
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Teléfono corroborado
            </label>
            <input
              type="text"
              value={manualPhone}
              onChange={(e) => setManualPhone(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono-tabular"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Sitio web oficial propio
            </label>
            <input
              type="url"
              value={manualWebsite}
              onChange={(e) => setManualWebsite(e.target.value)}
              placeholder="https://empresa.pe"
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Correo independiente
            </label>
            <input
              type="email"
              value={manualEmail}
              onChange={(e) => setManualEmail(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-700 mb-1">Notas</label>
            <input
              type="text"
              value={manualNotes}
              onChange={(e) => setManualNotes(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div className="md:col-span-3 flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={manualConfirmedNoWeb}
                onChange={(e) => setManualConfirmedNoWeb(e.target.checked)}
              />
              Confirmado sin sitio web propio
            </label>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold bg-purple-700 text-white rounded-lg hover:bg-purple-800"
            >
              Guardar en CRM
            </button>
          </div>
        </form>
      )}

      {/* Queue split filter + Stage segmented filter + search */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 pb-2 border-b border-slate-100 text-xs">
          <span className="font-semibold text-slate-600">Separación de colas:</span>
          <button
            type="button"
            onClick={() => {
              setQueueFilter('all');
              setCurrentPage(1);
            }}
            className={`px-2.5 py-1 rounded-md border ${
              queueFilter === 'all'
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-slate-50 text-slate-700 border-slate-200'
            }`}
          >
            Todas ({followups.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setQueueFilter('complete_only');
              setCurrentPage(1);
            }}
            className={`px-2.5 py-1 rounded-md border ${
              queueFilter === 'complete_only'
                ? 'bg-emerald-700 text-white border-emerald-700'
                : 'bg-slate-50 text-emerald-800 border-emerald-200'
            }`}
          >
            Fichas Comerciales Completas ({liveCounts.completeCount})
          </button>
          <button
            type="button"
            onClick={() => {
              setQueueFilter('incomplete_queue');
              setCurrentPage(1);
            }}
            className={`px-2.5 py-1 rounded-md border ${
              queueFilter === 'incomplete_queue'
                ? 'bg-amber-700 text-white border-amber-700'
                : 'bg-slate-50 text-amber-800 border-amber-200'
            }`}
          >
            Cola de Investigación / Incompletas ({liveCounts.incompleteCount})
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => {
              setStageFilter('all');
              setCurrentPage(1);
            }}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              stageFilter === 'all'
                ? 'bg-purple-700 text-white border-purple-700'
                : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
            }`}
          >
            Todos ({followups.length})
          </button>
          {FOLLOWUP_STAGES.map((stage) => {
            const count = followups.filter((f) => f.stage === stage).length;
            return (
              <button
                key={stage}
                type="button"
                onClick={() => {
                  setStageFilter(stage);
                  setCurrentPage(1);
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                  stageFilter === stage
                    ? 'bg-purple-700 text-white border-purple-700'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {stage} ({count})
              </button>
            );
          })}
        </div>

        <input
          type="text"
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setCurrentPage(1);
          }}
          placeholder="Filtrar seguimiento por nombre, dirección, web, categoría, Place ID, distrito, teléfono o notas..."
          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-sm text-slate-500">
          No hay registros de seguimiento para el filtro seleccionado. Usa &ldquo;Analizar y preseleccionar para seguimiento&rdquo; en el Explorador o agrega un registro independiente.
        </div>
      ) : (
        <>
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
                <tr>
                  {onDeleteFollowupsBatch && (
                    <th className="py-3 pl-4 pr-2 w-8">
                      <input
                        type="checkbox"
                        checked={allVisibleFollowupsSelected}
                        onChange={() => {
                          setSelectedFollowupIds((prev) => {
                            const next = new Set(prev);
                            if (allVisibleFollowupsSelected) {
                              for (const f of paginatedFollowups) next.delete(f.id);
                            } else {
                              for (const f of paginatedFollowups) next.add(f.id);
                            }
                            return next;
                          });
                        }}
                        aria-label="Seleccionar registros visibles de Seguimiento"
                        className="rounded border-slate-300 text-purple-700 focus:ring-purple-600"
                      />
                    </th>
                  )}
                  <th className="py-3 px-4">Empresa, Dirección, Web y Procedencia</th>
                  <th className="py-3 px-3">Estado Comercial (9 etapas)</th>
                  <th className="py-3 px-3">Teléfono, Tipo y Autorización</th>
                  <th className="py-3 px-3 text-right">Puntajes</th>
                  <th className="py-3 px-4">Notas y Gestión</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {paginatedFollowups.map((item) => {
                  const isEditing = editingId === item.id;
                  const isClientLocked = item.stage === 'CLIENTE';
                  const hydrationEntry = hydrationCache[item.placeId];
                  const hydrated = isHydrationEntryUsable(hydrationEntry)
                    ? hydrationEntry.details
                    : null;
                  const phoneDisplay = resolveFollowupPhoneDisplay(item, hydrationEntry);
                  const completeness = evaluateFollowupCompleteness(item);

                  const persistedName = item.independentBusinessName?.trim() || '';
                  const persistentAddress = item.independentAddress?.trim() || '';
                  const persistentWebsite = item.independentWebsite?.trim() || '';
                  const persistentCategory = item.independentCategory?.trim() || '';

                  const mapsUrl =
                    hydrated?.googleMapsUri ||
                    (!item.placeId.startsWith('manual_')
                      ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(item.placeId)}`
                      : null);

                  const completenessClass =
                    completeness.status === 'complete'
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : completeness.status === 'partial'
                      ? 'bg-amber-50 text-amber-800 border-amber-200'
                      : 'bg-slate-100 text-slate-700 border-slate-200';

                  return (
                    <tr key={item.id} className="hover:bg-slate-50 align-top">
                      {onDeleteFollowupsBatch && (
                        <td className="py-3 pl-4 pr-2">
                          <input
                            type="checkbox"
                            checked={selectedFollowupIds.has(item.id)}
                            onChange={() => {
                              setSelectedFollowupIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(item.id)) next.delete(item.id);
                                else next.add(item.id);
                                return next;
                              });
                            }}
                            aria-label={`Seleccionar documento ${item.id}`}
                            className="mt-1 rounded border-slate-300 text-purple-700 focus:ring-purple-600"
                          />
                        </td>
                      )}
                      <td className="py-3 px-4 max-w-[330px]">
                        {persistedName ? (
                          <div className="font-semibold text-slate-900">{persistedName}</div>
                        ) : (
                          <div>
                            <div className="font-semibold text-amber-900">
                              Sin nombre comercial persistido ({item.placeId})
                            </div>
                            {hydrated?.displayName && (
                              <div className="text-[11px] text-slate-500 mt-0.5">
                                Ref. sesión Explorador (NO persistido en Firestore):{' '}
                                <span className="font-medium text-slate-700">
                                  {hydrated.displayName}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                        {persistentCategory && (
                          <div className="text-[11px] font-medium text-purple-800 mt-0.5">
                            Categoría: {persistentCategory}
                          </div>
                        )}

                        <div className="text-slate-600 mt-0.5 text-[11px] space-y-0.5">
                          {(persistentAddress || item.district) && (
                            <div>
                              {persistentAddress && (
                                <span className="text-slate-800">{persistentAddress}</span>
                              )}
                              {persistentAddress && item.district ? ' · ' : ''}
                              {item.district && (
                                <span className="font-medium text-slate-700">
                                  Distrito: {item.district}
                                </span>
                              )}
                            </div>
                          )}

                          {!persistentAddress && hydrated?.formattedAddress && (
                            <div className="text-slate-500">
                              {hydrated.formattedAddress}{' '}
                              <span className="text-slate-400">(sesión Explorador)</span>
                            </div>
                          )}
                        </div>

                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium border rounded-md ${completenessClass}`}
                          >
                            {completeness.label}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleOpenRecord(item)}
                            className="text-[11px] font-semibold text-purple-700 hover:underline inline-flex items-center gap-1"
                          >
                            <Eye className="w-3 h-3" />
                            Abrir ficha
                          </button>
                        </div>

                        <div className="text-[11px] text-slate-500 mt-1.5 flex flex-wrap items-center gap-2">
                          <span>
                            {item.confirmedNoWebsite
                              ? 'Confirmado sin web (WEBNEX)'
                              : `Web: ${item.independentWebsiteStatus}`}
                          </span>
                          {item.qualificationTier && (
                            <span className="font-semibold text-purple-800">
                              · {item.qualificationTier}
                            </span>
                          )}
                        </div>

                        {item.verificationSources && item.verificationSources.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {item.verificationSources.slice(0, 2).map((raw, i) => {
                              const parsed = parseVerificationProvenanceEntry(raw);
                              return (
                                <span
                                  key={i}
                                  className="px-1.5 py-0.5 bg-slate-100 border border-slate-200 rounded text-[10px] text-slate-700"
                                  title={parsed.evidence}
                                >
                                  {parsed.field}: {formatIndependentSourceLabel(parsed.source)}
                                </span>
                              );
                            })}
                          </div>
                        )}

                        <div className="mt-1 flex flex-wrap items-center gap-3">
                          {persistentWebsite && (
                            <a
                              href={persistentWebsite}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] text-emerald-800 font-medium hover:underline"
                            >
                              Sitio web oficial
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          {mapsUrl && (
                            <a
                              href={mapsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] text-purple-700 hover:underline"
                            >
                              Ver en Google Maps
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-3">
                        <select
                          value={item.stage}
                          disabled={isClientLocked}
                          onChange={(e) =>
                            handleStageChange(item, e.target.value as FollowupStage)
                          }
                          className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white disabled:bg-slate-100"
                        >
                          {FOLLOWUP_STAGES.map((st) => (
                            <option key={st} value={st}>
                              {st}
                            </option>
                          ))}
                        </select>
                        {isClientLocked && (
                          <div className="text-[10px] text-emerald-700 mt-1">
                            CLIENTE confirmado (etapa bloqueada)
                          </div>
                        )}
                        <div className="text-[10px] text-slate-600 mt-1.5 font-medium">
                          {evaluateFourStagePipelineStatus(item).currentStageLabel}
                        </div>
                      </td>

                      <td className="py-3 px-3 max-w-[270px]">
                        {isEditing && !isClientLocked ? (
                          <div className="space-y-1.5">
                            <input
                              type="text"
                              value={draftName}
                              onChange={(e) => setDraftName(e.target.value)}
                              placeholder="Nombre comercial independiente"
                              className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                            />
                            <input
                              type="text"
                              value={draftCategory}
                              onChange={(e) => setDraftCategory(e.target.value)}
                              placeholder="Categoría comercial propia"
                              className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                            />
                            <input
                              type="text"
                              value={draftAddress}
                              onChange={(e) => setDraftAddress(e.target.value)}
                              placeholder="Dirección independiente"
                              className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                            />
                            <input
                              type="text"
                              value={draftDistrict}
                              onChange={(e) => setDraftDistrict(e.target.value)}
                              placeholder="Distrito independiente"
                              className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                            />
                            <input
                              type="url"
                              value={draftWebsite}
                              onChange={(e) => setDraftWebsite(e.target.value)}
                              placeholder="Sitio web oficial"
                              className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                            />
                            <input
                              type="text"
                              value={draftPhone}
                              onChange={(e) => setDraftPhone(e.target.value)}
                              placeholder="Teléfono corroborado"
                              className="w-full px-2 py-1 border border-slate-300 rounded text-xs font-mono-tabular"
                            />
                            <input
                              type="email"
                              value={draftEmail}
                              onChange={(e) => setDraftEmail(e.target.value)}
                              placeholder="Correo independiente"
                              className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                            />
                            <input
                              type="text"
                              value={draftLegalBasis}
                              onChange={(e) => setDraftLegalBasis(e.target.value)}
                              placeholder="Base legal / evidencia consentimiento"
                              className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                            />
                          </div>
                        ) : (
                          <div className="space-y-1">
                            {phoneDisplay.independentPhoneText && (
                              <div>
                                <div className="text-[10px] font-semibold text-emerald-800">
                                  Teléfono persistido (WEBNEX)
                                </div>
                                <div className="font-mono-tabular text-slate-900">
                                  {phoneDisplay.independentPhoneText}{' '}
                                  <span className="font-sans text-[11px] text-slate-600">
                                    · Tipo:{' '}
                                    {item.independentPhoneType
                                      ? formatPhoneLineTypeLabel(item.independentPhoneType)
                                      : phoneDisplay.independentLineTypeLabel}
                                  </span>
                                </div>
                              </div>
                            )}

                            {!phoneDisplay.independentPhoneText && phoneDisplay.placesPhoneText && (
                              <div>
                                <div className="text-[10px] font-semibold text-slate-500">
                                  Ref. sesión Explorador
                                </div>
                                <div className="font-mono-tabular text-slate-800">
                                  {phoneDisplay.placesPhoneText}{' '}
                                  <span className="font-sans text-[11px] text-slate-600">
                                    · Tipo: {phoneDisplay.placesLineTypeLabel}
                                  </span>
                                </div>
                              </div>
                            )}

                            {!phoneDisplay.independentPhoneText && !phoneDisplay.placesPhoneText && (
                              <div className="text-slate-500">
                                Sin teléfono propio registrado aún
                              </div>
                            )}

                            <div className="text-[11px] text-slate-500">
                              {getPhoneStageLabel(item.phoneStage)}
                            </div>

                            {item.independentEmail && (
                              <div className="text-[11px] text-purple-700">
                                {item.independentEmail}
                              </div>
                            )}

                            <div className="text-[11px] pt-0.5 text-slate-600">
                              Base legal:{' '}
                              {item.legalBasis ? (
                                <span className="text-emerald-800 font-medium">
                                  {item.legalBasis}
                                </span>
                              ) : (
                                <span className="text-amber-700">Sin autorización aún</span>
                              )}
                            </div>
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-3 text-right font-mono-tabular">
                        <div className="text-purple-800 font-semibold">
                          Dig: {item.independentDigitalScore}/100
                        </div>
                        <div className="text-slate-700 mt-0.5">
                          Cont: {item.independentContactScore}/100
                        </div>
                        {typeof item.independentTrustScore === 'number' && (
                          <div className="text-emerald-800 mt-0.5">
                            Conf: {item.independentTrustScore}/100
                          </div>
                        )}
                        {item.commercialOutcome && item.commercialOutcome !== 'none' && (
                          <div className="font-sans text-[10px] text-purple-800 mt-1 font-medium">
                            {getCommercialOutcomeLabel(item.commercialOutcome)}
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-4 max-w-xs">
                        {isEditing ? (
                          <div className="space-y-2">
                            <textarea
                              rows={2}
                              value={draftNotes}
                              onChange={(e) => setDraftNotes(e.target.value)}
                              className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                            />
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={async () => {
                                  const nowIso = new Date().toISOString();
                                  const manualEntries: string[] = [];
                                  if (draftName.trim() !== item.independentBusinessName && draftName.trim()) {
                                    manualEntries.push(
                                      encodeVerificationProvenanceEntry({
                                        field: 'nombre',
                                        source: 'user_manual_entry',
                                        evidence: draftName.trim(),
                                        verifiedAt: nowIso,
                                      })
                                    );
                                  }
                                  if (draftPhone.trim() !== item.independentPhone && draftPhone.trim()) {
                                    manualEntries.push(
                                      encodeVerificationProvenanceEntry({
                                        field: 'teléfono',
                                        source: 'user_manual_entry',
                                        evidence: draftPhone.trim(),
                                        verifiedAt: nowIso,
                                      })
                                    );
                                  }
                                  if (draftAddress.trim() !== (item.independentAddress || '') && draftAddress.trim()) {
                                    manualEntries.push(
                                      encodeVerificationProvenanceEntry({
                                        field: 'dirección',
                                        source: 'user_manual_entry',
                                        evidence: draftAddress.trim(),
                                        verifiedAt: nowIso,
                                      })
                                    );
                                  }
                                  if (draftWebsite.trim() !== (item.independentWebsite || '') && draftWebsite.trim()) {
                                    manualEntries.push(
                                      encodeVerificationProvenanceEntry({
                                        field: 'web',
                                        source: 'user_manual_entry',
                                        evidence: draftWebsite.trim(),
                                        verifiedAt: nowIso,
                                      })
                                    );
                                  }

                                  const websiteChanged =
                                    draftWebsite.trim() !== (item.independentWebsite || '').trim();
                                  const nextWebsiteStatus =
                                    websiteChanged ||
                                    (draftWebsite.trim() && item.independentWebsiteStatus === 'unregistered')
                                      ? resolveIndependentWebsiteStatusForSave({
                                          independentWebsite: draftWebsite,
                                          confirmedNoWebsite: item.confirmedNoWebsite,
                                          verifiedProbe: null,
                                        })
                                      : undefined;

                                  const outcome = await onUpdateFollowup(
                                    item.id,
                                    isClientLocked
                                      ? { notes: draftNotes }
                                      : {
                                          independentBusinessName: draftName,
                                          independentCategory: draftCategory,
                                          independentAddress: draftAddress,
                                          district: draftDistrict,
                                          independentWebsite: draftWebsite,
                                          ...(nextWebsiteStatus
                                            ? { independentWebsiteStatus: nextWebsiteStatus }
                                            : {}),
                                          notes: draftNotes,
                                          independentPhone: draftPhone,
                                          independentEmail: draftEmail,
                                          legalBasis: draftLegalBasis,
                                          ...(manualEntries.length > 0
                                            ? {
                                                lastVerifiedAt: nowIso,
                                                verificationSources: mergeVerificationSources(
                                                  item.verificationSources,
                                                  manualEntries,
                                                  8
                                                ),
                                              }
                                            : {}),
                                        },
                                    item
                                  );
                                  if (outcome && outcome.persistedRecord) {
                                    setServerVerificationNotice({
                                      docId: outcome.persistedRecord.id,
                                      report: buildPersistedVerificationReport(
                                        outcome.persistedRecord
                                      ),
                                    });
                                  }
                                  setEditingId(null);
                                }}
                                className="px-2.5 py-1 bg-purple-700 text-white rounded text-xs font-medium"
                              >
                                Guardar
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingId(null)}
                                className="px-2.5 py-1 border border-slate-300 rounded text-xs"
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            {item.aiSummary && (
                              <p className="text-[11px] text-purple-900 bg-purple-50 border border-purple-100 rounded p-1.5 mb-1.5">
                                {item.aiSummary}
                              </p>
                            )}
                            <p className="text-slate-600 whitespace-pre-wrap break-words">
                              {item.notes || 'Sin notas'}
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(item.id);
                                setDraftName(item.independentBusinessName);
                                setDraftCategory(item.independentCategory || '');
                                setDraftAddress(item.independentAddress || '');
                                setDraftDistrict(item.district);
                                setDraftWebsite(item.independentWebsite || '');
                                setDraftNotes(item.notes);
                                setDraftPhone(item.independentPhone);
                                setDraftEmail(item.independentEmail);
                                setDraftLegalBasis(item.legalBasis);
                              }}
                              className="mt-1 text-purple-700 hover:underline font-medium"
                            >
                              Editar datos / autorización
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            currentPage={safePage}
            totalItems={filtered.length}
            itemsPerPage={CRM_ITEMS_PER_PAGE}
            onPageChange={(page) => {
              setCurrentPage(page);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        </>
      )}

      {/* Modal de Ficha Individual (100% Firestore, 0 llamadas Google Places) */}
      {openedRecord && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Ficha de prospecto en Seguimiento"
        >
          {(() => {
            const entry = hydrationCache[openedRecord.placeId];
            const usableDetails = isHydrationEntryUsable(entry) ? entry.details : null;
            const phoneDisplay = resolveFollowupPhoneDisplay(openedRecord, entry);
            const statusMeta = getHydrationStatusMeta(entry, openedRecord.placeId, {
              quotaBlocked: placesQuotaBlock.blocked,
            });
            const completeness = evaluateFollowupCompleteness(openedRecord);
            const persistedReport = buildPersistedVerificationReport(openedRecord);
            const mapsUrl =
              usableDetails?.googleMapsUri ||
              (!openedRecord.placeId.startsWith('manual_')
                ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(openedRecord.placeId)}`
                : null);

            return (
              <div className="bg-white border border-slate-200 rounded-xl shadow-xl max-w-2xl w-full p-5 space-y-4 max-h-[90vh] overflow-y-auto">
                <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-3">
                  <div>
                    <div className="text-[11px] font-semibold text-purple-700">
                      Ficha Comercial Persistente (Firebase Firestore · 0 consultas Places)
                    </div>
                    <h3 className="text-base font-semibold text-slate-900 mt-0.5">
                      {openedRecord.independentBusinessName?.trim() ||
                        `Sin nombre persistido (Place ID: ${openedRecord.placeId})`}
                    </h3>
                    {!openedRecord.independentBusinessName?.trim() && usableDetails?.displayName && (
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Ref. sesión Explorador (NO persistido en Firestore): {usableDetails.displayName}
                      </div>
                    )}
                    <div className="text-[11px] text-slate-500 font-mono-tabular">
                      ID Doc: {openedRecord.id} · Place ID: {openedRecord.placeId} · {completeness.label}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpenedRecordId(null)}
                    className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
                    aria-label="Cerrar ficha"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5">
                    <div className="font-semibold text-slate-800">Ficha comercial persistida (Firebase)</div>
                    <div>
                      Nombre comercial: <strong>{openedRecord.independentBusinessName || 'Pendiente'}</strong>
                    </div>
                    <div>
                      Categoría propia: <strong>{openedRecord.independentCategory || 'No registrada'}</strong>
                    </div>
                    <div>
                      Dirección: <strong>{openedRecord.independentAddress || 'Pendiente'}</strong>
                    </div>
                    <div>
                      Distrito: <strong>{openedRecord.district || 'No registrado'}</strong>
                    </div>
                    <div>
                      Teléfono:{' '}
                      <strong className="font-mono-tabular">
                        {phoneDisplay.independentPhoneText || 'No registrado'}
                      </strong>{' '}
                      {phoneDisplay.independentPhoneText && (
                        <span className="text-slate-600">
                          (
                          {openedRecord.independentPhoneType
                            ? formatPhoneLineTypeLabel(openedRecord.independentPhoneType)
                            : phoneDisplay.independentLineTypeLabel}
                          )
                        </span>
                      )}
                    </div>
                    <div>
                      Correo: <strong>{openedRecord.independentEmail || 'No registrado'}</strong>
                    </div>
                    <div>
                      Sitio web:{' '}
                      {openedRecord.independentWebsite ? (
                        <a
                          href={openedRecord.independentWebsite}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-purple-700 underline break-all"
                        >
                          {openedRecord.independentWebsite}
                        </a>
                      ) : (
                        <strong>
                          {openedRecord.confirmedNoWebsite
                            ? 'Confirmado sin web (WEBNEX)'
                            : openedRecord.independentWebsiteStatus}
                        </strong>
                      )}
                    </div>
                  </div>

                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5">
                    <div className="font-semibold text-slate-800">
                      Gestión comercial y procedencia
                    </div>
                    <div>
                      Etapa: <strong>{openedRecord.stage}</strong>
                    </div>
                    <div>
                      Clasificación: <strong>{openedRecord.qualificationTier || 'Sin etiqueta'}</strong>
                    </div>
                    <div>
                      Puntajes: <strong>Dig {openedRecord.independentDigitalScore}/100</strong> ·{' '}
                      <strong>Cont {openedRecord.independentContactScore}/100</strong>
                      {typeof openedRecord.independentTrustScore === 'number' && (
                        <>
                          {' '}
                          · <strong>Conf {openedRecord.independentTrustScore}/100</strong>
                        </>
                      )}
                    </div>
                    <div>
                      Base legal:{' '}
                      <strong>{openedRecord.legalBasis || 'Sin autorización aún'}</strong>
                    </div>
                    <div>
                      Última verificación:{' '}
                      <strong>
                        {openedRecord.lastVerifiedAt
                          ? openedRecord.lastVerifiedAt.slice(0, 19).replace('T', ' ')
                          : 'Sin fecha registrada'}
                      </strong>
                    </div>
                    {openedRecord.verificationSummary && (
                      <div className="text-[11px] text-slate-600">
                        {openedRecord.verificationSummary}
                      </div>
                    )}
                    <div className="pt-1 border-t border-slate-200 text-[11px] text-slate-500">
                      Sesión Explorador: {usableDetails ? usableDetails.displayName : statusMeta.label}
                    </div>
                    {mapsUrl && (
                      <a
                        href={mapsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-purple-700 hover:underline font-medium"
                      >
                        Abrir en Google Maps
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>

                {completeness.isFichaIncompleta && (
                  <div className="text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-amber-950 space-y-1.5">
                    <div className="font-semibold">
                      {completeness.label}: no está completa en Firestore.
                    </div>
                    {persistedReport.missingReasons.length > 0 && (
                      <ul className="text-[11px] space-y-0.5">
                        {persistedReport.missingReasons.map((r, i) => (
                          <li key={i}>• {r}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {openedRecord.stage !== 'CLIENTE' &&
                  (completeness.isFichaIncompleta || !openedRecord.independentAddress?.trim()) && (
                    <div className="text-xs bg-emerald-50/60 border border-emerald-200 rounded-lg p-3.5 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="font-semibold text-emerald-950">
                            Investigar y completar solo campos vacíos en Firestore (0 Places · sin sobrescribir)
                          </div>
                          <div className="text-[11px] text-emerald-900/80">
                            Conserva intactos teléfono, correo, distrito, categoría, etapa, notas, base legal y fechas ya guardadas. Etapa embudo:{' '}
                            <strong>{evaluateFourStagePipelineStatus(openedRecord).currentStageLabel}</strong>.
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={repairCorroborating}
                          onClick={async () => {
                            setRepairCorroborating(true);
                            setRepairFeedback(null);
                            try {
                              const url =
                                repairWebsite.trim() || openedRecord.independentWebsite || '';
                              const evidenceClean = repairEvidenceText.trim();
                              const response = await researchMissingLeadDataBatch([
                                {
                                  placeId: openedRecord.placeId,
                                  officialWebsiteUrl: url || null,
                                  socialOrDirectoryUrl: repairSocialUrl.trim() || null,
                                  userProvidedEvidenceText: evidenceClean,
                                  notesText: openedRecord.notes,
                                  searchCategory: openedRecord.independentCategory || '',
                                  searchDistrict: openedRecord.district || '',
                                  allowGeminiEvidenceAnalysis: evidenceClean.length >= 15,
                                  sessionMapsRef: usableDetails
                                    ? {
                                        name: usableDetails.displayName,
                                        address: usableDetails.formattedAddress,
                                        phone:
                                          usableDetails.internationalPhoneNumber ||
                                          usableDetails.nationalPhoneNumber ||
                                          '',
                                        website: usableDetails.websiteUri || '',
                                        district: openedRecord.district || '',
                                      }
                                    : undefined,
                                },
                              ]);
                              const research = response.results[0];
                              if (research) {
                                setRepairResearchResult(research);
                                const corr = research.corroboration;
                                if (!openedRecord.independentBusinessName?.trim() && !repairName.trim() && corr.candidates.businessName?.value) {
                                  setRepairName(corr.candidates.businessName.value);
                                }
                                if (!openedRecord.independentAddress?.trim() && !repairAddress.trim() && corr.candidates.address?.value) {
                                  setRepairAddress(corr.candidates.address.value);
                                }
                                if (!openedRecord.independentWebsite?.trim() && !repairWebsite.trim() && corr.candidates.website?.value) {
                                  setRepairWebsite(corr.candidates.website.value);
                                }
                                if (!research.hasContradictions && !openedRecord.independentPhone?.trim() && !repairPhone.trim() && corr.candidates.phone?.value) {
                                  setRepairPhone(corr.candidates.phone.value);
                                }
                                if (!openedRecord.district?.trim() && !repairDistrict.trim() && corr.candidates.district?.value) {
                                  setRepairDistrict(corr.candidates.district.value);
                                }
                                if (!openedRecord.independentEmail?.trim() && !repairEmail.trim() && corr.candidates.email?.value) {
                                  setRepairEmail(corr.candidates.email.value);
                                }
                                if (!openedRecord.independentCategory?.trim() && !repairCategory.trim() && corr.candidates.category?.value) {
                                  setRepairCategory(corr.candidates.category.value);
                                }
                                if (corr.candidates.businessName?.source) {
                                  setRepairSource(corr.candidates.businessName.source);
                                } else if (corr.candidates.address?.source) {
                                  setRepairSource(corr.candidates.address.source);
                                }
                                setRepairFeedback(`${research.summary} (0 Places).`);
                              }
                            } catch (err: any) {
                              setRepairFeedback(err?.message || 'Error investigando fuentes independientes.');
                            } finally {
                              setRepairCorroborating(false);
                            }
                          }}
                          className="px-2.5 py-1.5 text-[11px] font-semibold bg-purple-700 text-white rounded-md hover:bg-purple-800 disabled:opacity-50 inline-flex items-center gap-1"
                        >
                          <Search className="w-3 h-3" />
                          {repairCorroborating
                            ? 'Investigando (0 Places)...'
                            : 'Investigar datos faltantes (0 Places)'}
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          type="url"
                          value={repairSocialUrl}
                          onChange={(e) => setRepairSocialUrl(e.target.value)}
                          placeholder="URL Facebook / Instagram / DatosPeru (opcional)"
                          className="px-2.5 py-1.5 text-xs border border-emerald-200 rounded bg-white"
                        />
                        <input
                          type="text"
                          value={repairEvidenceText}
                          onChange={(e) => setRepairEvidenceText(e.target.value)}
                          placeholder="Texto / evidencia propia (extracción literal 0 invención)"
                          className="px-2.5 py-1.5 text-xs border border-emerald-200 rounded bg-white"
                        />
                      </div>

                      {repairResearchResult && (
                        <div className="bg-white border border-emerald-200 rounded p-2.5 space-y-2 text-[11px]">
                          <div className="font-semibold text-slate-800">
                            {repairResearchResult.identityMatch.summary}
                          </div>
                          {repairResearchResult.contradictionAlerts.length > 0 && (
                            <div className="bg-rose-50 border border-rose-300 text-rose-900 rounded px-2 py-1">
                              {repairResearchResult.contradictionAlerts.map((a, idx) => (
                                <div key={idx}>• {a}</div>
                              ))}
                            </div>
                          )}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                            {(['businessName', 'phone', 'address', 'website'] as ResearchableFieldKey[]).map((fk) => {
                              const fc = repairResearchResult.fieldClassifications[fk];
                              const meta = getFieldClassificationMeta(fc.status);
                              return (
                                <div key={fk} className="bg-slate-50 border border-slate-200 rounded p-1.5">
                                  <div className="font-semibold text-slate-700">{fc.label}</div>
                                  <div className={`inline-block px-1 py-0.5 text-[10px] border rounded mt-0.5 ${meta.badgeClass}`}>
                                    {meta.shortLabel}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div className="space-y-0.5 text-[10px] text-slate-600">
                            {repairResearchResult.sourceAttempts.map((att, idx) => (
                              <div key={idx}>
                                • <strong>{att.sourceName}</strong> ({att.status}
                                {att.httpStatus ? ` · HTTP ${att.httpStatus}` : ''}): {att.detail}
                              </div>
                            ))}
                          </div>
                          {repairResearchResult.manualReviewLinks.length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-100">
                              {repairResearchResult.manualReviewLinks.map((lnk, i) => (
                                <a
                                  key={i}
                                  href={lnk.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-purple-700 hover:underline font-medium"
                                >
                                  {lnk.label}
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {!openedRecord.independentBusinessName?.trim() && (
                          <input
                            type="text"
                            value={repairName}
                            onChange={(e) => setRepairName(e.target.value)}
                            placeholder="Nombre comercial faltante (fuente propia / web)"
                            className="px-2.5 py-1.5 text-xs border border-emerald-300 rounded bg-white"
                          />
                        )}
                        {!openedRecord.independentAddress?.trim() && (
                          <input
                            type="text"
                            value={repairAddress}
                            onChange={(e) => setRepairAddress(e.target.value)}
                            placeholder="Dirección faltante (fuente propia / web)"
                            className="px-2.5 py-1.5 text-xs border border-emerald-300 rounded bg-white"
                          />
                        )}
                        {!openedRecord.independentWebsite?.trim() && !openedRecord.confirmedNoWebsite && (
                          <input
                            type="url"
                            value={repairWebsite}
                            onChange={(e) => setRepairWebsite(e.target.value)}
                            placeholder="Sitio web oficial faltante (https://...)"
                            className="px-2.5 py-1.5 text-xs border border-emerald-300 rounded bg-white"
                          />
                        )}
                        {!openedRecord.independentPhone?.trim() && (
                          <input
                            type="text"
                            value={repairPhone}
                            onChange={(e) => setRepairPhone(e.target.value)}
                            placeholder="Teléfono faltante"
                            className="px-2.5 py-1.5 text-xs border border-emerald-300 rounded bg-white font-mono-tabular"
                          />
                        )}
                        {!openedRecord.district?.trim() && (
                          <input
                            type="text"
                            value={repairDistrict}
                            onChange={(e) => setRepairDistrict(e.target.value)}
                            placeholder="Distrito faltante"
                            className="px-2.5 py-1.5 text-xs border border-emerald-300 rounded bg-white"
                          />
                        )}
                        {!openedRecord.independentEmail?.trim() && (
                          <input
                            type="email"
                            value={repairEmail}
                            onChange={(e) => setRepairEmail(e.target.value)}
                            placeholder="Correo faltante"
                            className="px-2.5 py-1.5 text-xs border border-emerald-300 rounded bg-white"
                          />
                        )}
                        {!openedRecord.independentCategory?.trim() && (
                          <input
                            type="text"
                            value={repairCategory}
                            onChange={(e) => setRepairCategory(e.target.value)}
                            placeholder="Categoría faltante"
                            className="px-2.5 py-1.5 text-xs border border-emerald-300 rounded bg-white"
                          />
                        )}
                      </div>

                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="space-y-1.5 flex-1">
                          <select
                            value={repairSource}
                            onChange={(e) => setRepairSource(e.target.value as IndependentFieldSource)}
                            className="w-full sm:w-auto px-2.5 py-1 text-[11px] border border-emerald-300 rounded bg-white"
                          >
                            <option value="user_manual_entry">Captura manual verificada del usuario</option>
                            <option value="official_website_html">Web oficial del comercio</option>
                            <option value="authorized_public_source">Fuente empresarial autorizada</option>
                            <option value="phone_call_verified">Corroboración telefónica directa</option>
                          </select>
                          <label className="flex items-center gap-1.5 text-[11px] text-emerald-950 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={repairConfirmed}
                              onChange={(e) => setRepairConfirmed(e.target.checked)}
                            />
                            Confirmo procedencia independiente (solo completa campos vacíos)
                          </label>
                        </div>
                        <button
                          type="button"
                          disabled={
                            repairSaving ||
                            !repairConfirmed ||
                            (!repairName.trim() &&
                              !repairAddress.trim() &&
                              !repairWebsite.trim() &&
                              !repairPhone.trim() &&
                              !repairDistrict.trim() &&
                              !repairEmail.trim() &&
                              !repairCategory.trim())
                          }
                          onClick={async () => {
                            setRepairSaving(true);
                            setRepairFeedback(null);
                            try {
                              const nowIso = new Date().toISOString();
                              const srcList: string[] = [];
                              const addSrc = (field: string, val: string) => {
                                if (!val.trim()) return;
                                srcList.push(
                                  encodeVerificationProvenanceEntry({
                                    field,
                                    source: repairSource,
                                    evidence: val.trim(),
                                    verifiedAt: nowIso,
                                  })
                                );
                              };
                              addSrc('nombre', repairName);
                              addSrc('dirección', repairAddress);
                              addSrc('web', repairWebsite);
                              addSrc('teléfono', repairPhone);
                              addSrc('distrito', repairDistrict);
                              addSrc('correo', repairEmail);
                              addSrc('categoría', repairCategory);

                              if (onRecoverMissingFields) {
                                const res = await onRecoverMissingFields([
                                  {
                                    id: openedRecord.id,
                                    independentBusinessName: repairName.trim() || undefined,
                                    independentAddress: repairAddress.trim() || undefined,
                                    independentWebsite: repairWebsite.trim() || undefined,
                                    independentPhone: repairPhone.trim() || undefined,
                                    district: repairDistrict.trim() || undefined,
                                    independentEmail: repairEmail.trim() || undefined,
                                    independentCategory: repairCategory.trim() || undefined,
                                    verificationSummary:
                                      'Reparación parcial no destructiva ejecutada desde Abrir ficha.',
                                    lastVerifiedAt: nowIso,
                                    verificationSources: srcList,
                                  },
                                ]);
                                const verifiedDoc = res.verifiedRecords?.[0];
                                if (verifiedDoc) {
                                  const rep = buildPersistedVerificationReport(verifiedDoc);
                                  setServerVerificationNotice({ docId: verifiedDoc.id, report: rep });
                                  setRepairFeedback(
                                    rep.isComplete
                                      ? `Reparación verificada en servidor Firestore (${res.fieldsCompleted} campo(s) completado(s)). Ficha ahora 4/4 completa.`
                                      : `Reparados ${res.fieldsCompleted} campo(s) vacíos. Estado actual en Firestore: ${rep.status}.`
                                  );
                                } else {
                                  setRepairFeedback(
                                    `Operación completada (${res.fieldsCompleted} campo(s) completado(s), sin sobrescribir existentes).`
                                  );
                                }
                              }
                              setRepairName('');
                              setRepairAddress('');
                              setRepairWebsite('');
                              setRepairPhone('');
                              setRepairDistrict('');
                              setRepairEmail('');
                              setRepairCategory('');
                            } catch (err: any) {
                              setRepairFeedback(err?.message || 'Error al completar campos vacíos.');
                            } finally {
                              setRepairSaving(false);
                            }
                          }}
                          className="px-3 py-1.5 text-xs font-semibold bg-emerald-700 text-white rounded-md hover:bg-emerald-800 disabled:opacity-40 shrink-0"
                        >
                          {repairSaving ? 'Completando...' : 'Completar solo vacíos en Firestore'}
                        </button>
                      </div>

                      {repairFeedback && (
                        <div className="text-[11px] bg-white border border-emerald-300 rounded px-2.5 py-1.5 text-emerald-950">
                          {repairFeedback}
                        </div>
                      )}
                    </div>
                  )}

                {openedRecord.verificationSources && openedRecord.verificationSources.length > 0 && (
                  <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5">
                    <div className="font-semibold text-slate-700">Trazabilidad de fuentes verificadas</div>
                    <div className="flex flex-wrap gap-1.5">
                      {openedRecord.verificationSources.map((raw, idx) => {
                        const parsed = parseVerificationProvenanceEntry(raw);
                        return (
                          <span
                            key={idx}
                            className="px-2 py-0.5 bg-white border border-slate-200 rounded text-[11px] text-slate-700"
                          >
                            <strong>{parsed.field}:</strong> {parsed.sourceLabel} ({parsed.evidence})
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* FASE 6: Registro estructurado de resultado comercial real */}
                <div className="text-xs bg-purple-50/50 border border-purple-200 rounded-lg p-3 space-y-2.5">
                  <div className="font-semibold text-purple-950">
                    Registrar resultado comercial real (aprendizaje del embudo)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <select
                      value={outcomeDraftType}
                      onChange={(e) => setOutcomeDraftType(e.target.value as CommercialOutcomeType)}
                      className="px-2.5 py-1.5 text-xs border border-purple-200 rounded-md bg-white"
                    >
                      {COMMERCIAL_OUTCOME_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={outcomeDraftSource}
                      onChange={(e) => setOutcomeDraftSource(e.target.value)}
                      placeholder="Canal / fuente (ej: llamada_directa)"
                      className="px-2.5 py-1.5 text-xs border border-purple-200 rounded-md bg-white"
                    />
                    <input
                      type="text"
                      value={outcomeDraftContext}
                      onChange={(e) => setOutcomeDraftContext(e.target.value)}
                      placeholder="Detalle observable del contacto"
                      className="px-2.5 py-1.5 text-xs border border-purple-200 rounded-md bg-white"
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[11px] text-slate-600">
                      Actual:{' '}
                      <strong>
                        {getCommercialOutcomeLabel(openedRecord.commercialOutcome)}
                      </strong>
                      {openedRecord.outcomeRecordedAt
                        ? ` (${openedRecord.outcomeRecordedAt.slice(0, 16).replace('T', ' ')})`
                        : ''}
                    </div>
                    <button
                      type="button"
                      disabled={savingOutcome}
                      onClick={async () => {
                        setSavingOutcome(true);
                        try {
                          await onUpdateFollowup(
                            openedRecord.id,
                            {
                              commercialOutcome: outcomeDraftType,
                              outcomeSource: outcomeDraftSource.trim() || 'registro_crm',
                              outcomeContext: outcomeDraftContext.trim(),
                              outcomeRecordedAt: new Date().toISOString(),
                            },
                            openedRecord
                          );
                        } finally {
                          setSavingOutcome(false);
                        }
                      }}
                      className="px-3 py-1.5 text-xs font-semibold bg-purple-700 text-white rounded-md hover:bg-purple-800 disabled:opacity-50"
                    >
                      {savingOutcome ? 'Guardando...' : 'Guardar resultado real'}
                    </button>
                  </div>
                  {openedRecord.outcomeHistory && openedRecord.outcomeHistory.length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-purple-200/70">
                      <div className="text-[11px] font-medium text-purple-900">
                        Historial reciente de resultados:
                      </div>
                      {openedRecord.outcomeHistory.slice(0, 5).map((raw, idx) => {
                        const parsed = parseOutcomeHistoryEntry(raw);
                        return (
                          <div key={idx} className="text-[11px] text-slate-700">
                            • <strong>{parsed.label}</strong> ({parsed.source})
                            {parsed.context ? ` — ${parsed.context}` : ''}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {openedRecord.notes && (
                  <div className="text-xs bg-white border border-slate-200 rounded-lg p-3">
                    <div className="font-semibold text-slate-700 mb-1">Notas guardadas</div>
                    <p className="text-slate-600 whitespace-pre-wrap">{openedRecord.notes}</p>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                  <button
                    type="button"
                    onClick={() => setOpenedRecordId(null)}
                    className="px-4 py-2 text-xs font-medium border border-slate-300 rounded-lg hover:bg-slate-50"
                  >
                    Cerrar
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {onRecoverMissingFields && (
        <FollowupRecoveryModal
          isOpen={recoveryOpen}
          followups={followups}
          onClose={() => setRecoveryOpen(false)}
          onRecoverMissingFields={onRecoverMissingFields}
        />
      )}
    </div>
  );
};
