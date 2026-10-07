let token = sessionStorage.getItem('opendots-token') ?? '';
export function setToken(value: string) {
  token = value;
  if (value) sessionStorage.setItem('opendots-token', value);
  else sessionStorage.removeItem('opendots-token');
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(['GET', 'HEAD'].includes(method)
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response
    .json()
    .catch(() => ({ error: 'Server returned an unreadable response.' }))) as {
    error?: string;
  };
  if (!response.ok)
    throw new ApiError(
      data.error ?? `Request failed (${response.status}).`,
      response.status,
    );
  return data as T;
}
/** Sends a file as multipart form data; `fields` with arrays repeat the key. */
export async function upload<T>(
  path: string,
  file: File,
  fields: Record<string, string | string[] | undefined> = {},
): Promise<T> {
  const form = new FormData();
  form.append('file', file, file.name);
  for (const [key, value] of Object.entries(fields))
    for (const item of Array.isArray(value) ? value : value ? [value] : [])
      form.append(key, item);
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  const data = (await response
    .json()
    .catch(() => ({ error: 'Server returned an unreadable response.' }))) as {
    error?: string;
  };
  if (!response.ok)
    throw new ApiError(
      data.error ?? `Upload failed (${response.status}).`,
      response.status,
    );
  return data as T;
}
/** Downloads through fetch so the access token is sent, then saves the blob. */
export async function download(path: string, fileName: string) {
  const response = await fetch(`/api${path}`, { headers: authHeaders() });
  if (!response.ok)
    throw new ApiError(
      `Download failed (${response.status}).`,
      response.status,
    );
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
