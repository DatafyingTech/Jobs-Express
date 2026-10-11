// Talking to the local server. All state lives on this computer.
export const DEMO_QUERY = new URLSearchParams(location.search).get('demo') === '1';

// The server puts a random per-launch token in the page it serves. Only this page can read it, and every request carries it.
const TOKEN = document.querySelector('meta[name="cja-token"]')?.content || '';

const baseHeaders = () => ({ 'x-cja': '1', 'x-cja-token': TOKEN, ...(DEMO_QUERY ? { 'x-cja-demo': '1' } : {}) });

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
export const DELETE = (p) => api('DELETE', p);

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

/**
 * Live updates over server-sent events. Done with fetch rather than EventSource so the token travels in a header,
 * and so a dropped connection reconnects on its own.
 */
export function connectEvents(on) {
  let stopped = false;
  let controller = null;
  const dispatch = (block) => {
    let name = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    try {
      on(name, JSON.parse(data.join('\n')));
    } catch {
      /* ignore a malformed event */
    }
  };
  (async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch('/api/events', { headers: baseHeaders(), signal: controller.signal });
        if (!res.ok || !res.body) throw new Error('refused');
        on('connection', { ok: true });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            dispatch(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
        }
      } catch {
        /* fall through to the reconnect below */
      }
      if (stopped) break;
      on('connection', { ok: false });
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  return { close() { stopped = true; controller?.abort(); } };
}

export const csvUrl = '/api/applications.csv' + (DEMO_QUERY ? '?demo=1' : '');
