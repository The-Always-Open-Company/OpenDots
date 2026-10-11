import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'v1:';

function key() {
  const raw = process.env.PLUGIN_SECRET_KEY?.trim();
  if (!raw) return null;
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32)
    throw new Error('PLUGIN_SECRET_KEY must be 32 bytes, base64 encoded.');
  return bytes;
}

export function secretStorageAvailable() {
  try {
    return key() !== null;
  } catch {
    return false;
  }
}

function requireKey() {
  const bytes = key();
  if (!bytes)
    throw new Error(
      'Set PLUGIN_SECRET_KEY on the server to store plugin credentials.',
    );
  return bytes;
}

export function encryptSecret(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', requireKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return (
    PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
  );
}

export function decryptSecret(sealed: string) {
  if (!sealed.startsWith(PREFIX))
    throw new Error('Stored plugin credential is unreadable.');
  const bytes = Buffer.from(sealed.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    requireKey(),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  try {
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(
      'Stored plugin credential could not be decrypted. Was PLUGIN_SECRET_KEY changed?',
    );
  }
}

/** The pieces of a secret URL that must never appear in output. */
export function urlSecrets(raw: string) {
  const secrets = [raw];
  try {
    const url = new URL(raw);
    if (url.search.length > 1) secrets.push(url.search.slice(1));
    for (const value of url.searchParams.values())
      if (value.length >= 8) secrets.push(value);
    for (const segment of url.pathname.split('/'))
      if (segment.length >= 16) secrets.push(segment);
  } catch {
    // An unparseable URL is still redacted as a whole.
  }
  return secrets;
}

export function redactText(text: string, secrets: string[]) {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    if (secret) out = out.split(secret).join('[redacted]');
  return out;
}

export function redactSecrets(value: unknown, secrets: string[]) {
  return JSON.parse(
    redactText(JSON.stringify(value ?? null), secrets),
  ) as unknown;
}
