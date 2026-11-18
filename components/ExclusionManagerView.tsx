import React, { useMemo, useState } from 'react';
import { CheckCircle2, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { ExclusionRecord } from '../types';
import {
  ExclusionBatchParseResult,
  parseExclusionBatchInput,
} from '../utils/exclusionUtils';
import type { FirestorePreflightResult } from '../services/firebaseService';

interface ExclusionManagerViewProps {
  isSignedIn: boolean;
  userEmail?: string;
  exclusions: ExclusionRecord[];
  exclusionKeys: Set<string>;
  onSignIn: () => void;
  onVerifyFirestoreAccess: () => Promise<FirestorePreflightResult>;
  onImportBatch: (
    candidates: ExclusionBatchParseResult['uniqueEntries'],
    sourceLabel: string,
    onProgress: (written: number, total: number) => void
  ) => Promise<number>;
  onDeleteExclusion: (id: string) => Promise<void>;
}

export const ExclusionManagerView: React.FC<ExclusionManagerViewProps> = ({
  isSignedIn,
  userEmail,
  exclusions,
  exclusionKeys,
  onSignIn,
  onVerifyFirestoreAccess,
  onImportBatch,
  onDeleteExclusion,
}) => {
  const [rawInput, setRawInput] = useState('');
  const [sourceLabel, setSourceLabel] = useState('Histórico descartados WEBNEX');
  const [preview, setPreview] = useState<ExclusionBatchParseResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isVerifyingDb, setIsVerifyingDb] = useState(false);
  const [dbVerification, setDbVerification] = useState<FirestorePreflightResult | null>(null);

  const visibleExclusions = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    const list = q
      ? exclusions.filter(
          (e) =>
            e.normalizedValue.toLowerCase().includes(q) ||
            e.rawSample.toLowerCase().includes(q) ||
            e.sourceLabel.toLowerCase().includes(q)
        )
      : exclusions;
    return list.slice(0, 200);
  }, [exclusions, searchFilter]);

  if (!isSignedIn) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
        <h2 className="text-lg font-semibold text-slate-900">
          Listas de Exclusión Privadas
        </h2>
        <p className="text-sm text-slate-600 mt-2 max-w-lg mx-auto">
          Inicia sesión con Google para cargar de forma segura tu lista histórica (como los 4,767 descartados de WEBNEX) con normalización de teléfonos peruanos y dominios.
        </p>
        <button
          type="button"
          onClick={onSignIn}
          className="mt-5 px-5 py-2.5 text-sm font-semibold bg-purple-700 text-white rounded-lg hover:bg-purple-800 transition-colors"
        >
          Iniciar sesión con Google
        </button>
      </div>
    );
  }

  const handleAnalyze = (textToAnalyze: string) => {
    setErrorMsg(null);
    const parsed = parseExclusionBatchInput(textToAnalyze, exclusionKeys, 10000);
    setPreview(parsed);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRawInput(text);
    setSourceLabel(file.name.slice(0, 100));
    handleAnalyze(text);
  };

  const handleVerifyDb = async (): Promise<boolean> => {
    setIsVerifyingDb(true);
    setErrorMsg(null);
    try {
      const result = await onVerifyFirestoreAccess();
      setDbVerification(result);
      return result.ok && result.writeVerified && result.readVerified;
    } catch (err: any) {
      setDbVerification(null);
      setErrorMsg(err?.message || 'No se pudo verificar escritura y lectura en Firestore.');
      return false;
    } finally {
      setIsVerifyingDb(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!preview || preview.uniqueEntries.length === 0) return;
    setImporting(true);
    setErrorMsg(null);
    try {
      if (!dbVerification?.ok) {
        const verified = await handleVerifyDb();
        if (!verified) {
          setImporting(false);
          return;
        }
      }
      const saved = await onImportBatch(
        preview.uniqueEntries,
        sourceLabel.trim() || 'Importación WEBNEX',
        (written, total) => {
          setProgressText(`Guardando lote seguro: ${written}/${total}...`);
        }
      );
      setProgressText(`Importación completada: ${saved} registros nuevos guardados.`);
      setPreview(null);
      setRawInput('');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error importando exclusiones.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Importador Seguro de Listas de Exclusión WEBNEX
            </h2>
            <p className="text-xs text-slate-600 mt-1">
              Esta lista inicia vacía hasta que proporciones tus archivos o registros propios (ej. lista histórica WEBNEX de 4,767 descartados). Normaliza automáticamente teléfonos peruanos (+51), dominios web y Place IDs, evitando duplicados.
            </p>
          </div>
          <button
            type="button"
            disabled={isVerifyingDb || importing}
            onClick={handleVerifyDb}
            className="px-3 py-2 text-xs font-semibold border border-purple-300 bg-purple-50 text-purple-900 rounded-lg hover:bg-purple-100 disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <ShieldCheck className="w-4 h-4 text-purple-700" />
            {isVerifyingDb ? 'Probando Firestore...' : 'Probar escritura y lectura Firestore'}
          </button>
        </div>

        {dbVerification && (
          <div className="text-xs bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg px-3 py-2 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>{dbVerification.message}</span>
          </div>
        )}

        {!dbVerification && (
          <div className="text-xs bg-slate-50 border border-slate-200 text-slate-700 rounded-lg px-3 py-2">
            Sesión Google activa ({userEmail || 'correo verificado'}). Antes de importar listas masivas se ejecutará una prueba mínima de escritura y lectura en tu colección privada de Firestore.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Etiqueta de origen
            </label>
            <input
              type="text"
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Subir archivo CSV o TXT (soporta miles de filas)
            </label>
            <label className="flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium border border-dashed border-slate-300 rounded-lg cursor-pointer hover:bg-slate-50">
              <Upload className="w-4 h-4 text-purple-700" />
              <span>Seleccionar CSV / TXT</span>
              <input
                type="file"
                accept=".csv,.txt"
                onChange={handleFileChange}
                className="hidden"
              />
            </label>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            O pega aquí teléfonos peruanos, dominios o Place IDs (uno por línea o separados por coma)
          </label>
          <textarea
            rows={5}
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            placeholder="987654321&#10;https://www.empresa.pe&#10;ChIJifIePKtZwokRVZ-UdRGkZzs"
            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono-tabular"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!rawInput.trim() || importing}
            onClick={() => handleAnalyze(rawInput)}
            className="px-4 py-2 text-xs font-semibold border border-slate-300 rounded-lg text-slate-800 hover:bg-slate-50 disabled:opacity-50"
          >
            Analizar y normalizar antes de guardar
          </button>

          {preview && preview.uniqueEntries.length > 0 && (
            <button
              type="button"
              disabled={importing}
              onClick={handleConfirmImport}
              className="px-4 py-2 text-xs font-semibold bg-purple-700 text-white rounded-lg hover:bg-purple-800 disabled:opacity-50"
            >
              {importing
                ? progressText
                : `Importar ${preview.uniqueEntries.length} registros únicos`}
            </button>
          )}
        </div>

        {preview && (
          <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1 font-mono-tabular">
            <div>Líneas procesadas: {preview.totalLinesProcessed}</div>
            <div className="text-emerald-800 font-semibold">
              Nuevos registros normalizados listos: {preview.uniqueEntries.length}
            </div>
            <div className="text-slate-600">
              Duplicados omitidos: {preview.skippedDuplicates} · No reconocidos: {preview.skippedUnrecognized}
            </div>
          </div>
        )}

        {progressText && !importing && (
          <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            {progressText}
          </div>
        )}

        {errorMsg && (
          <div className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {errorMsg}
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">
            Exclusiones cargadas ({exclusions.length})
          </h3>
          <input
            type="text"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="Buscar teléfono, dominio o Place ID..."
            className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg sm:w-72"
          />
        </div>

        {visibleExclusions.length === 0 ? (
          <p className="text-xs text-slate-500 py-4">
            Aún no hay exclusiones registradas en tu cuenta.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
                <tr>
                  <th className="py-2 px-3">Tipo</th>
                  <th className="py-2 px-3">Valor normalizado</th>
                  <th className="py-2 px-3">Origen</th>
                  <th className="py-2 px-3 text-right">Eliminar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {visibleExclusions.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="py-2 px-3 font-medium text-slate-700">{item.type}</td>
                    <td className="py-2 px-3 font-mono-tabular text-slate-900">
                      {item.normalizedValue}
                    </td>
                    <td className="py-2 px-3 text-slate-500">{item.sourceLabel}</td>
                    <td className="py-2 px-3 text-right">
                      <button
                        type="button"
                        onClick={() => onDeleteExclusion(item.id)}
                        className="p-1 text-slate-500 hover:text-rose-700"
                        title="Eliminar exclusión"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {exclusions.length > 200 && (
              <p className="text-[11px] text-slate-500 mt-2">
                Mostrando primeros 200 de {exclusions.length} registros (todas las {exclusions.length} entradas siguen activas para deduplicación).
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
