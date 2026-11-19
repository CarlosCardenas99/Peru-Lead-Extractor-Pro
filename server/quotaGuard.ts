import { QuotaStatus } from '../types';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class DailyQuotaGuard {
  private placesLimit: number;
  private geminiLimit: number;
  private currentDay: string;
  private placesUsed = 0;
  private placesFailed = 0;
  private googleQuotaBlocked = false;
  private googleQuotaBlockedMessage: string | null = null;
  private geminiUsed = 0;
  private cache = new Map<string, CacheEntry<unknown>>();
  private cacheTtlMs: number;

  constructor(options?: { placesLimit?: number; geminiLimit?: number; cacheTtlMs?: number }) {
    this.placesLimit = options?.placesLimit ?? Number(process.env.PLACES_DAILY_LIMIT || 60);
    this.geminiLimit = options?.geminiLimit ?? Number(process.env.GEMINI_DAILY_LIMIT || 40);
    // Session/server memory cache max 30 min (never persisted to disk/DB, compatible with GMP ToS)
    this.cacheTtlMs = options?.cacheTtlMs ?? 30 * 60 * 1000;
    this.currentDay = this.getLimaDate();
  }

  private getLimaDate(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  private rolloverIfNewDay(): void {
    const today = this.getLimaDate();
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.placesUsed = 0;
      this.placesFailed = 0;
      this.googleQuotaBlocked = false;
      this.googleQuotaBlockedMessage = null;
      this.geminiUsed = 0;
      this.cache.clear();
    }
  }

  getCached<T>(key: string): T | null {
    this.rolloverIfNewDay();
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  setCached<T>(key: string, value: T): void {
    this.rolloverIfNewDay();
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  canUsePlaces(): boolean {
    this.rolloverIfNewDay();
    return !this.googleQuotaBlocked && this.placesUsed < this.placesLimit;
  }

  hasReachedLocalPlacesLimit(): boolean {
    this.rolloverIfNewDay();
    return this.placesUsed >= this.placesLimit;
  }

  isGoogleQuotaBlocked(): boolean {
    this.rolloverIfNewDay();
    return this.googleQuotaBlocked;
  }

  getGoogleQuotaBlockMessage(): string | null {
    this.rolloverIfNewDay();
    return this.googleQuotaBlockedMessage;
  }

  /**
   * Contabiliza únicamente solicitudes Places completadas con respuesta válida.
   */
  recordPlacesSuccess(): void {
    this.rolloverIfNewDay();
    this.placesUsed++;
  }

  /**
   * Registra una solicitud Places fallida SIN sumarla al contador de recuperaciones exitosas.
   * Si el motivo es 429 / RESOURCE_EXHAUSTED de Google, activa el bloqueo inmediato para detener consultas.
   */
  recordPlacesFailure(reason: 'google_quota' | 'error', message?: string): void {
    this.rolloverIfNewDay();
    this.placesFailed++;
    if (reason === 'google_quota') {
      this.googleQuotaBlocked = true;
      this.googleQuotaBlockedMessage =
        message ||
        'Google Places API (New) devolvió 429 RESOURCE_EXHAUSTED (cuota real de Google agotada).';
    }
  }

  // Compatibilidad con llamadas existentes que consumen cuota preventiva explícita
  consumePlaces(): void {
    this.recordPlacesSuccess();
  }

  canUseGemini(): boolean {
    this.rolloverIfNewDay();
    return this.geminiUsed < this.geminiLimit;
  }

  consumeGemini(): void {
    this.rolloverIfNewDay();
    this.geminiUsed++;
  }

  getStatus(): QuotaStatus {
    this.rolloverIfNewDay();
    return {
      dateLima: this.currentDay,
      placesUsed: this.placesUsed,
      placesLimit: this.placesLimit,
      placesFailed: this.placesFailed,
      googleQuotaBlocked: this.googleQuotaBlocked,
      googleQuotaBlockedMessage: this.googleQuotaBlockedMessage,
      geminiUsed: this.geminiUsed,
      geminiLimit: this.geminiLimit,
      note: 'El contador local mide únicamente llamadas exitosas de esta instancia de servidor y es independiente de la cuota real diaria asignada en Google Maps Platform.',
    };
  }
}
