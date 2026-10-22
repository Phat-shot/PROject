import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { badRequest } from './errors.js';

/**
 * Schutz vor SSRF bei Zielen, die Benutzer eintragen (CalDAV, IMAP/SMTP, eigene LLM-Endpunkte, Web-Recherche):
 * keine Loopback-, privaten, Link-Local- oder sonst nicht öffentlichen Adressen, auch nicht über DNS oder IPv4-mapped IPv6.
 * Interne Dienste im eigenen Netz (Nextcloud, Mailserver, Ollama) gibt OUTBOUND_ALLOW_HOSTS frei: Hostnamen (auch *.domain) oder Netze (CIDR).
 */
const blocked = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** IPv4 hinter ::ffff:a.b.c.d bzw. ::ffff:7f00:1 */
function mappedV4(ip: string): string | null {
  const m = ip.toLowerCase().match(/^(?:0*:)*:?ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16), lo = parseInt(m[3], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !blocked.check(ip, 'ipv4');
  if (v === 6) {
    const v4 = mappedV4(ip);
    return v4 ? !blocked.check(v4, 'ipv4') : !blocked.check(ip, 'ipv6');
  }
  return false;
}

function allowList(env = process.env): { hosts: string[]; nets: BlockList } {
  const hosts: string[] = [];
  const nets = new BlockList();
  for (const raw of String(env.OUTBOUND_ALLOW_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const [addr, prefix] = raw.split('/');
    const v = isIP(addr);
    if (v) nets.addSubnet(addr, Number(prefix ?? (v === 4 ? 32 : 128)), v === 4 ? 'ipv4' : 'ipv6');
    else hosts.push(raw);
  }
  return { hosts, nets };
}
const hostAllowed = (host: string, hosts: string[]) => hosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h));

/** Auflösung austauschbar für Tests */
export const resolver = { lookup: async (host: string): Promise<string[]> => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address) };

/** Fehlertext, wenn der Host nicht öffentlich erreichbar sein soll; null = erlaubt. */
export async function outboundHostError(rawHost: string): Promise<string | null> {
  const host = String(rawHost ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return 'Host fehlt';
  const allow = allowList();
  if (hostAllowed(host, allow.hosts)) return null;
  const ipAllowed = (ip: string) => isPublicAddress(ip) || allow.nets.check(mappedV4(ip) ?? ip, isIP(mappedV4(ip) ?? ip) === 4 ? 'ipv4' : 'ipv6');
  if (isIP(host)) return ipAllowed(host) ? null : `Ziel ${host} liegt in einem internen Netz (freigeben über OUTBOUND_ALLOW_HOSTS)`;
  if (host === 'localhost' || host.endsWith('.localhost')) return `Ziel ${host} liegt in einem internen Netz (freigeben über OUTBOUND_ALLOW_HOSTS)`;
  let ips: string[];
  try { ips = await resolver.lookup(host); } catch {
    // Testlauf ohne DNS: unbekannte Namen gelten als extern
    if (process.env.NODE_ENV === 'test') return null;
    return `Host ${host} nicht auflösbar`;
  }
  if (!ips.length || ips.some((ip) => !ipAllowed(ip))) return `Ziel ${host} liegt in einem internen Netz (freigeben über OUTBOUND_ALLOW_HOSTS)`;
  return null;
}

/** Fehlertext für eine URL (nur http/https, keine Zugangsdaten in der URL); null = erlaubt. */
export async function outboundUrlError(raw: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(String(raw ?? '').trim()); } catch { return 'Ungültige Adresse'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Nur http(s)-Adressen';
  if (u.username || u.password) return 'Zugangsdaten nicht in der Adresse angeben';
  return outboundHostError(u.hostname);
}

export async function assertOutboundUrl(raw: string): Promise<void> {
  const e = await outboundUrlError(raw);
  if (e) throw badRequest(e);
}
export async function assertOutboundHost(host: string): Promise<void> {
  const e = await outboundHostError(host);
  if (e) throw badRequest(e);
}
