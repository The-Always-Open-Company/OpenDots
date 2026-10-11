import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';

const RESPONSE_LIMIT = 1_000_000;
export const CALL_TIMEOUT_MS = 30_000;

const ipv4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
] as const)
  ipv4.addSubnet(net, prefix, 'ipv4');
ipv4.addAddress('255.255.255.255', 'ipv4');

const ipv6 = new BlockList();
ipv6.addAddress('::1', 'ipv6');
ipv6.addAddress('::', 'ipv6');
ipv6.addSubnet('fc00::', 7, 'ipv6');
ipv6.addSubnet('fe80::', 10, 'ipv6');
ipv6.addSubnet('ff00::', 8, 'ipv6');
// IPv4-mapped, NAT64, and 6to4 addresses can carry a private IPv4 address.
ipv6.addSubnet('::ffff:0:0', 96, 'ipv6');
ipv6.addSubnet('64:ff9b::', 96, 'ipv6');
ipv6.addSubnet('2002::', 16, 'ipv6');

export function isBlockedAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return ipv4.check(address, 'ipv4');
  if (version === 6) return ipv6.check(address, 'ipv6');
  return true;
}

const BLOCKED = 'Plugin URL resolves to a private or local address.';

/** Validates the address the socket actually connects to, closing the DNS rebinding gap. */
const publicOnly = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, { ...options, all: true }, (error, found) => {
        if (error) return callback(error, '', 0);
        const addresses = found as LookupAddress[];
        if (
          !addresses.length ||
          addresses.some((a) => isBlockedAddress(a.address))
        )
          return callback(new Error(BLOCKED), '', 0);
        if (options.all) return callback(null, addresses as never);
        callback(null, addresses[0].address, addresses[0].family);
      });
    },
  },
});

export async function assertPublicUrl(
  raw: string,
  resolve: typeof lookup = lookup,
) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Plugin URL is invalid.');
  }
  if (url.username || url.password)
    throw new Error('Plugin URL cannot include credentials.');
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (loopback) {
    if (process.env.NODE_ENV === 'production')
      throw new Error('Local plugin URLs are not allowed in production.');
    return url;
  }
  if (url.protocol !== 'https:') throw new Error('Plugin URL must use https.');
  const literal = isIP(url.hostname);
  const addresses = literal
    ? [{ address: url.hostname }]
    : await resolve(url.hostname, { all: true });
  for (const entry of addresses)
    if (isBlockedAddress(entry.address)) throw new Error(BLOCKED);
  return url;
}

export async function pluginFetch(url: string, init: RequestInit = {}) {
  await assertPublicUrl(typeof url === 'string' ? url : String(url));
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    dispatcher: publicOnly,
    signal: AbortSignal.any([
      AbortSignal.timeout(CALL_TIMEOUT_MS),
      ...(init.signal ? [init.signal] : []),
    ]),
  } as RequestInit);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > RESPONSE_LIMIT)
    throw new Error('Plugin response is too large.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > RESPONSE_LIMIT)
    throw new Error('Plugin response is too large.');
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
