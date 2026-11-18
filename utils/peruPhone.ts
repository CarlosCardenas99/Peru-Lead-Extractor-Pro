import { PeruvianPhoneAnalysis, PhoneVerificationStage } from '../types';

const REGIONAL_AREA_CODES = new Set([
  '41', '42', '43', '44',
  '51', '52', '53', '54', '56',
  '61', '62', '63', '64', '65', '66', '67',
  '72', '73', '74', '76',
  '82', '83', '84',
]);

/**
 * Normaliza y valida teléfonos peruanos sin asumir disponibilidad de WhatsApp
 * ni inventar dígitos faltantes.
 */
export function analyzePeruvianPhone(
  rawInput: string | null | undefined,
  overrideStage?: PhoneVerificationStage
): PeruvianPhoneAnalysis {
  const raw = (rawInput || '').trim();
  if (!raw || raw.toLowerCase() === 'n/a' || raw === '-') {
    return {
      raw: '',
      e164: null,
      formatted: null,
      lineType: 'none',
      isValidFormat: false,
      stage: overrideStage && overrideStage !== 'none' ? overrideStage : 'none',
      note: 'Sin teléfono registrado',
    };
  }

  // Strip extension suffixes like "anx 102", "ext. 5", "#2"
  const cleanedPart = raw.split(/\b(?:ext|anx|anexo|int)\b/i)[0].trim();
  let digits = cleanedPart.replace(/\D/g, '');

  // Handle international prefix 0051 or +51 / 51
  if (digits.startsWith('0051') && digits.length >= 12) {
    digits = digits.slice(4);
  } else if (digits.startsWith('51') && (digits.length === 11 || digits.length === 10)) {
    digits = digits.slice(2);
  }

  // Mobile: 9 digits starting with 9
  if (/^9\d{8}$/.test(digits)) {
    const e164 = `+51${digits}`;
    const formatted = `+51 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    return {
      raw,
      e164,
      formatted,
      lineType: 'mobile',
      isValidFormat: true,
      stage: overrideStage || 'registered_valid_format',
      note: 'Celular peruano con formato válido (WhatsApp no asumido; requiere verificación)',
    };
  }

  // Lima/Callao landline: 01 + 7 digits (9 digits) OR 1 + 7 digits (8 digits)
  if (/^01\d{7}$/.test(digits)) {
    const local = digits.slice(2);
    return {
      raw,
      e164: `+511${local}`,
      formatted: `+51 (01) ${local.slice(0, 3)}-${local.slice(3)}`,
      lineType: 'landline_lima',
      isValidFormat: true,
      stage: overrideStage || 'registered_valid_format',
      note: 'Teléfono fijo Lima/Callao con formato válido',
    };
  }

  if (/^1\d{7}$/.test(digits)) {
    const local = digits.slice(1);
    return {
      raw,
      e164: `+511${local}`,
      formatted: `+51 (01) ${local.slice(0, 3)}-${local.slice(3)}`,
      lineType: 'landline_lima',
      isValidFormat: true,
      stage: overrideStage || 'registered_valid_format',
      note: 'Teléfono fijo Lima/Callao con formato válido',
    };
  }

  // Regional landline: 0 + 2-digit area code + 6 digits (9 digits) OR area code + 6 digits (8 digits)
  if (/^0\d{8}$/.test(digits) && REGIONAL_AREA_CODES.has(digits.slice(1, 3))) {
    const area = digits.slice(1, 3);
    const local = digits.slice(3);
    return {
      raw,
      e164: `+51${area}${local}`,
      formatted: `+51 (0${area}) ${local.slice(0, 3)}-${local.slice(3)}`,
      lineType: 'landline_regional',
      isValidFormat: true,
      stage: overrideStage || 'registered_valid_format',
      note: `Teléfono fijo regional (0${area}) con formato válido`,
    };
  }

  if (/^\d{8}$/.test(digits) && REGIONAL_AREA_CODES.has(digits.slice(0, 2))) {
    const area = digits.slice(0, 2);
    const local = digits.slice(2);
    return {
      raw,
      e164: `+51${area}${local}`,
      formatted: `+51 (0${area}) ${local.slice(0, 3)}-${local.slice(3)}`,
      lineType: 'landline_regional',
      isValidFormat: true,
      stage: overrideStage || 'registered_valid_format',
      note: `Teléfono fijo regional (0${area}) con formato válido`,
    };
  }

  return {
    raw,
    e164: null,
    formatted: null,
    lineType: 'invalid',
    isValidFormat: false,
    stage: overrideStage && overrideStage !== 'registered_valid_format' ? overrideStage : 'registered_invalid',
    note: 'Número registrado no cumple formato estándar peruano',
  };
}

export function getPhoneStageLabel(stage: PhoneVerificationStage): string {
  switch (stage) {
    case 'none':
      return 'Sin teléfono';
    case 'registered_invalid':
      return 'Registrado (formato no estándar)';
    case 'registered_valid_format':
      return 'Registrado · Formato peruano válido';
    case 'independently_corroborated':
      return 'Corroborado independientemente';
    case 'contact_reached':
      return 'Contacto alcanzado';
  }
}
