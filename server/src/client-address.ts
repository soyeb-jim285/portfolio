import { isIP } from 'node:net';

const normalize = (address: string) => {
  const value = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  return isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : value;
};

// Only an explicitly trusted socket peer may supply a proxy-overwritten, single X-Real-IP.
export function clientAddress(peer: string, forwarded: string | undefined, trusted: string[]) {
  const address = normalize(peer);
  return trusted.some(ip => normalize(ip) === address) && forwarded && isIP(forwarded)
    ? normalize(forwarded) : address;
}
