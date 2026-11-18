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
  private geminiUsed = 0;
  private cache = new Map<string, CacheEntry<unknown>>();
  private cacheTtlMs: number;

  constructor(options?: { placesLimit?: number; geminiLimit?: number; cacheTtlMs?: number }) {
    this.placesLimit = options?.placesLimit ?? Number(process.env.PLACES_DAILY_LIMIT || 60);
    this.geminiLimit = options?.geminiLimit ?? Number(process.env.GEMINI_DAILY_LIMIT || 40);
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
    return this.placesUsed < this.placesLimit;
  }

  consumePlaces(): void {
    this.rolloverIfNewDay();
    this.placesUsed++;
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
      geminiUsed: this.geminiUsed,
      geminiLimit: this.geminiLimit,
      note: 'Límite diario local de protección de cuota gratuita (Google AI Plus no incluye llamadas API ilimitadas).',
    };
  }
}
