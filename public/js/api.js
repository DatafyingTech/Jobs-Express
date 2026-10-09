// Talking to the local server. All state lives on this computer.
export const DEMO_QUERY = new URLSearchParams(location.search).get('demo') === '1';

const baseHeaders = () => ({ 'x-cja': '1', ...(DEMO_QUERY ? { 'x-cja-demo': '1' } : {}) });

export async function api(method, path, body) {
  const init = { method, headers: baseHeaders() };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('Could not reach the app. Is it still running in its window?');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error */
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const GET = (p) => api('GET', p);
export const POST = (p, b = {}) => api('POST', p, b);
export const PUT = (p, b) => api('PUT', p, b);

export async function uploadResume(file) {
  const res = await fetch('/api/resume', {
    method: 'POST',
    headers: { ...baseHeaders(), 'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed.');
  return data;
}

export function connectEvents(on) {
  const es = new EventSource('/api/events' + (DEMO_QUERY ? '?demo=1' : ''));
  for (const name of ['hello', 'log', 'run', 'records']) {
    es.addEventListener(name, (ev) => {
      try {
        on(name, JSON.parse(ev.data));
      } catch {
        /* ignore a malformed event */
      }
    });
  }
  es.onerror = () => on('connection', { ok: false });
  es.onopen = () => on('connection', { ok: true });
  return es;
}

export const csvUrl = '/api/applications.csv' + (DEMO_QUERY ? '?demo=1' : '');
