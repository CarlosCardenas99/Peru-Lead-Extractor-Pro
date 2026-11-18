import dns from 'node:dns/promises';
import net from 'node:net';

export type DnsLookupFn = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

const defaultDnsLookup: DnsLookupFn = async (hostname: string) => {
  return dns.lookup(hostname, { all: true });
};

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidrV4(ip: string, base: string, maskBits: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * Determina si una dirección IPv4 o IPv6 pertenece a rangos privados, loopback,
 * link-local (metadatos cloud 169.254.169.254), CGNAT o reservados.
 */
export function isPrivateOrReservedIp(ipRaw: string): boolean {
  const ip = ipRaw.trim().toLowerCase();

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (ip.startsWith('::ffff:')) {
    const tail = ip.slice(7);
    if (net.isIPv4(tail)) {
      return isPrivateOrReservedIp(tail);
    }
    const hexParts = tail.split(':');
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateOrReservedIp(v4);
      }
    }
    return true;
  }

  if (net.isIPv4(ip)) {
    return (
      inCidrV4(ip, '0.0.0.0', 8) ||
      inCidrV4(ip, '10.0.0.0', 8) ||
      inCidrV4(ip, '100.64.0.0', 10) || // CGNAT
      inCidrV4(ip, '127.0.0.0', 8) || // Loopback
      inCidrV4(ip, '169.254.0.0', 16) || // Link-local / Cloud Metadata
      inCidrV4(ip, '172.16.0.0', 12) || // Private RFC 1918
      inCidrV4(ip, '192.0.0.0', 24) ||
      inCidrV4(ip, '192.0.2.0', 24) ||
      inCidrV4(ip, '192.168.0.0', 16) || // Private RFC 1918
      inCidrV4(ip, '198.18.0.0', 15) ||
      inCidrV4(ip, '198.51.100.0', 24) ||
      inCidrV4(ip, '203.0.113.0', 24) ||
      inCidrV4(ip, '224.0.0.0', 4) || // Multicast
      inCidrV4(ip, '240.0.0.0', 4) // Reserved
    );
  }

  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    // Unique local fc00::/7 (fc00..fdff)
    if (/^f[cd][0-9a-f]{2}:/.test(ip) || ip.startsWith('fc') || ip.startsWith('fd')) return true;
    // Link-local fe80::/10
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;
    // Multicast ff00::/8
    if (ip.startsWith('ff')) return true;
    // Documentation 2001:db8::/32
    if (ip.startsWith('2001:db8:')) return true;
    return false;
  }

  return true;
}

export interface SafeUrlValidationResult {
  ok: true;
  parsedUrl: URL;
  resolvedIps: string[];
}

export interface SafeUrlValidationFailure {
  ok: false;
  code: 'INVALID_URL' | 'SSRF_BLOCKED' | 'DNS_NOT_FOUND' | 'DNS_ERROR';
  reason: string;
}

export async function validateAndResolveSafeUrl(
  rawUrl: string,
  dnsLookupFn: DnsLookupFn = defaultDnsLookup
): Promise<SafeUrlValidationResult | SafeUrlValidationFailure> {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return { ok: false, code: 'INVALID_URL', reason: 'URL vacía' };
  }

  let parsed: URL;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, code: 'INVALID_URL', reason: 'Sintaxis de URL inválida' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'SSRF_BLOCKED', reason: 'Solo se permiten esquemas HTTP/HTTPS' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, code: 'SSRF_BLOCKED', reason: 'URL con credenciales incrustadas bloqueada' };
  }

  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return { ok: false, code: 'SSRF_BLOCKED', reason: `Puerto no estándar (${parsed.port}) bloqueado` };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.arpa')
  ) {
    return { ok: false, code: 'SSRF_BLOCKED', reason: 'Host local o interno bloqueado por política SSRF' };
  }

  // Direct IP literal check
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bareHost)) {
    if (isPrivateOrReservedIp(bareHost)) {
      return { ok: false, code: 'SSRF_BLOCKED', reason: `IP privada o reservada bloqueada (${bareHost})` };
    }
    return { ok: true, parsedUrl: parsed, resolvedIps: [bareHost] };
  }

  if (!hostname.includes('.')) {
    return { ok: false, code: 'INVALID_URL', reason: 'Dominio sin TLD válido' };
  }

  try {
    const records = await dnsLookupFn(hostname);
    if (!records || records.length === 0) {
      return { ok: false, code: 'DNS_NOT_FOUND', reason: 'El dominio no resolvió direcciones DNS' };
    }

    const ips: string[] = [];
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        return {
          ok: false,
          code: 'SSRF_BLOCKED',
          reason: `Resolución DNS a IP privada/reservada bloqueada (${rec.address})`,
        };
      }
      ips.push(rec.address);
    }

    return { ok: true, parsedUrl: parsed, resolvedIps: ips };
  } catch (err: any) {
    const code = err?.code || '';
    if (code === 'ENOTFOUND' || code === 'EAI_NONAME' || code === 'ENODATA') {
      return { ok: false, code: 'DNS_NOT_FOUND', reason: `Dominio inexistente en DNS (${code})` };
    }
    return {
      ok: false,
      code: 'DNS_ERROR',
      reason: `Error temporal resolviendo DNS (${code || err?.message || 'desconocido'})`,
    };
  }
}
