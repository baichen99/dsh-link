// AgentLink v1 envelope: HKDF-SHA256(agentlink, e2e-v1), AES-256-GCM.
export const CHUNK_BYTES = 64 * 1024;
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
export function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function unbase64(text) {
  if (typeof text !== 'string' || !/^[\w-]*$/.test(text)) throw new Error('Invalid base64url');
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export async function encryptionKey(secret) {
  const bytes = unbase64(secret);
  if (bytes.length !== 32 || base64(bytes) !== secret) throw new Error('Invalid machine key');
  const key = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('agentlink'), info: new TextEncoder().encode('e2e-v1') }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encrypt(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ e2e: 1, iv: base64(iv), ct: base64(new Uint8Array(ct)) });
}
export async function decrypt(key, text) {
  if (typeof text !== 'string' || text.length > 256 * 1024) throw new Error('Frame too large');
  const envelope = JSON.parse(text);
  if (envelope?.e2e !== 1) throw new Error('Encrypted frame required');
  const iv = unbase64(envelope.iv);
  if (iv.length !== 12) throw new Error('Invalid nonce');
  const value = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, unbase64(envelope.ct));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
}

// A fresh host challenge binds frames to a tunnel; sequence numbers reject replay.
export function peer(key, write, session) {
  let outgoing = 0, incoming = 0;
  let sending = Promise.resolve();
  return {
    send(value) {
      const frame = { ...value, dsh: 1, session, seq: ++outgoing };
      sending = sending.then(async () => write(await encrypt(key, frame)));
      return sending;
    },
    async read(text) {
      const frame = await decrypt(key, text);
      if (frame?.dsh !== 1 || !Number.isSafeInteger(frame.seq) || frame.seq !== incoming + 1) throw new Error('Invalid frame sequence');
      if (session === undefined && frame.type === 'ready' && typeof frame.session === 'string' && /^[\w-]{32}$/.test(frame.session)) session = frame.session;
      if (!session || frame.session !== session) throw new Error('Wrong tunnel session');
      incoming = frame.seq;
      return frame;
    },
  };
}

export function targetPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /%(?:2e|2f|5c)/i.test(value)) throw new Error('Invalid DSH path');
  const url = new URL(value, 'http://dsh.internal');
  if (url.origin !== 'http://dsh.internal' || url.pathname.includes('%') || url.pathname.split('/').includes('..')) throw new Error('Invalid DSH path');
  if (url.pathname === '/agentlink/bootstrap' || url.pathname.startsWith('/plugins/')) return url.pathname + url.search;
  if (url.pathname.startsWith('/api/') && !/^\/api\/agentlink(?:\/|$)/.test(url.pathname)) return url.pathname + url.search;
  throw new Error('This route is local only');
}
