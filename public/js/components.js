import { h, get, set, mount } from './dom.js';
import { icon } from './icons.js';
import { S, markDirty, loadPreflight, testConnection, confirmLinkedin, on } from './state.js';
import { POST, uploadResume } from './api.js';

// ---------- toasts ----------
export function toast(message, kind = 'ok') {
  const root = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind === 'bad' ? 'bad' : ''}` }, icon(kind === 'bad' ? 'alert' : 'check', 16), h('span', {}, message));
  root.append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
}

export async function guard(fn, { fail = 'Something went wrong.' } = {}) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message || fail, 'bad');
    return undefined;
  }
}

// ---------- buttons ----------
export function button({ label, icon: ic, kind = '', size = '', onClick, title, disabled, href, target, ariaLabel, loading } = {}) {
  const cls = ['btn', kind, size, !label ? 'icon-only' : ''].filter(Boolean).join(' ');
  const kids = [loading ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : ic ? icon(ic, size === 'lg' ? 18 : 16) : null, label ? h('span', {}, label) : null];
  if (href) return h('a', { class: cls, href, target, rel: target ? 'noopener noreferrer' : null, title, 'aria-label': ariaLabel }, ...kids);
  return h('button', { class: cls, type: 'button', onClick, title, disabled: disabled || loading, 'aria-label': ariaLabel || (!label ? title : null) }, ...kids);
}

// ---------- form fields ----------
let uid = 0;
const nextId = () => `f${++uid}`;

export function field(label, control, { hint, required, span, id } = {}) {
  const target = control.matches('input,select,textarea') ? control : control.querySelector('input,select,textarea');
  const fid = id || target?.id || nextId();
  if (target && !target.id) target.id = fid;
  if (target && hint) target.setAttribute('aria-describedby', `${fid}-hint`);
  return h('div', { class: `field ${span ? 'span-2' : ''}` },
    label ? h('label', { for: fid }, label, required === false ? h('span', { class: 'req' }, ' (optional)') : null) : null,
    control,
    hint ? h('div', { class: 'hint', id: `${fid}-hint` }, hint) : null,
  );
}

function bindInput(el, path) {
  el.addEventListener('input', () => {
    set(S.draft, path, el.value);
    markDirty();
  });
  return el;
}

export function textInput(path, { type = 'text', placeholder, autocomplete, inputmode } = {}) {
  return bindInput(h('input', { class: 'input', type, value: get(S.draft, path) ?? '', placeholder, autocomplete, inputmode }), path);
}

export function textArea(path, { placeholder, rows = 3 } = {}) {
  const el = h('textarea', { class: 'textarea', rows, placeholder });
  el.value = get(S.draft, path) ?? '';
  return bindInput(el, path);
}

export function selectInput(path, options) {
  const el = h('select', { class: 'select' }, ...options.map((o) => h('option', { value: o }, o)));
  const current = get(S.draft, path);
  if (current && !options.includes(current)) el.prepend(h('option', { value: current }, current));
  el.value = current ?? options[0];
  el.addEventListener('change', () => {
    set(S.draft, path, el.value);
    markDirty();
  });
  return el;
}

export function numberInput(path, { placeholder, prefix } = {}) {
  const el = h('input', { class: 'input', type: 'text', inputmode: 'numeric', placeholder, value: get(S.draft, path) === '' ? '' : String(get(S.draft, path) ?? '') });
  el.addEventListener('input', () => {
    const digits = el.value.replace(/[^\d]/g, '');
    set(S.draft, path, digits === '' ? '' : Number(digits));
    markDirty();
  });
  if (!prefix) return el;
  return h('div', { class: 'input-affix' }, h('span', { class: 'affix', 'aria-hidden': 'true' }, prefix), el);
}

/** Toggle chips bound to an array of strings at `path`. */
export function chipGroup(path, options, { label } = {}) {
  const selected = () => get(S.draft, path) || [];
  const wrap = h('div', { class: 'chips', role: 'group', 'aria-label': label });
  const draw = () => {
    mount(wrap, ...options.map((o) => {
      const on = selected().includes(o);
      return h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(on),
        onClick: () => {
          const cur = selected();
          set(S.draft, path, on ? cur.filter((x) => x !== o) : [...cur, o]);
          markDirty();
          draw();
        },
      }, icon('check', 14), o);
    }));
  };
  draw();
  return wrap;
}

/** Free-text tags: type and press Enter or comma. */
export function tagInput(path, { placeholder, label } = {}) {
  const list = h('div', { class: 'chips' });
  const input = h('input', { class: 'input', type: 'text', placeholder, 'aria-label': label });
  const draw = () => {
    mount(list, ...(get(S.draft, path) || []).map((t) => h('span', { class: 'chip removable' }, t,
      h('button', { type: 'button', 'aria-label': `Remove ${t}`, onClick: () => { set(S.draft, path, get(S.draft, path).filter((x) => x !== t)); markDirty(); draw(); } }, icon('x', 12)))));
  };
  const add = () => {
    const v = input.value.replace(/,$/, '').trim();
    if (!v) return;
    const cur = get(S.draft, path) || [];
    if (!cur.some((x) => x.toLowerCase() === v.toLowerCase())) set(S.draft, path, [...cur, v]);
    input.value = '';
    markDirty();
    draw();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
    if (e.key === 'Backspace' && !input.value) {
      const cur = get(S.draft, path) || [];
      if (cur.length) { set(S.draft, path, cur.slice(0, -1)); markDirty(); draw(); }
    }
  });
  input.addEventListener('blur', add);
  draw();
  return h('div', { style: { display: 'grid', gap: '10px' } }, input, list);
}

export function segmented(options, value, onChange, { label, size } = {}) {
  const wrap = h('div', { class: `seg ${size || ''}`, role: 'group', 'aria-label': label });
  const draw = (v) => {
    mount(wrap, ...options.map((o) => h('button', {
      type: 'button', 'aria-pressed': String(o.value === v),
      onClick: () => { draw(o.value); onChange(o.value); },
    }, o.label, o.count != null ? h('span', { class: 'count' }, o.count) : null)));
  };
  draw(value);
  wrap.redraw = draw;
  return wrap;
}

export function switchRow({ title, desc, checked, onChange, id }) {
  const fid = id || nextId();
  const input = h('input', { type: 'checkbox', id: fid, checked: !!checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('div', { class: 'toggle-row' },
    h('div', { class: 'grow' }, h('label', { class: 't', for: fid }, title), h('div', { class: 'hint' }, desc)),
    h('span', { class: 'switch' }, input, h('span', { class: 'track' }), h('span', { class: 'thumb' })),
  );
}

export function radioList(path, options, name) {
  const cur = get(S.draft, path);
  return h('div', { class: 'radio-list', role: 'radiogroup' }, ...options.map((o) => {
    const input = h('input', { type: 'radio', name, value: o, checked: cur === o });
    input.addEventListener('change', () => { set(S.draft, path, o); markDirty(); });
    return h('label', {}, input, h('span', {}, o));
  }));
}

export function resumeDropzone() {
  const input = h('input', { type: 'file', accept: '.pdf,.doc,.docx,application/pdf', class: 'sr-only', id: 'resume-file' });
  const zone = h('label', { class: 'dropzone', for: 'resume-file', tabindex: '-1' });
  const draw = () => {
    const name = S.draft.about.resumeName;
    zone.className = `dropzone ${name ? 'has' : ''}`;
    mount(zone, h('span', { class: 'ico' }, icon(name ? 'check' : 'upload', 20)),
      h('span', {}, h('div', { class: 'name' }, name || 'Choose your resume, or drop it here'),
        h('div', { class: 'hint' }, name ? 'Saved on this computer. Choose another file to replace it.' : 'PDF or Word, up to 10 MB. It is copied into the app\'s data folder and uploaded only to the job sites you apply to.')));
  };
  const send = async (file) => {
    if (!file) return;
    try {
      const r = await uploadResume(file);
      S.draft.about.resumeName = r.resumeName;
      S.info.profile.about.resumeName = r.resumeName;
      toast('Resume saved.');
      draw();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  input.addEventListener('change', () => send(input.files[0]));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); send(e.dataTransfer.files[0]); });
  draw();
  return h('div', {}, input, zone);
}

// ---------- status ----------
const STATUS_LABEL = { submitted: 'Submitted', ready: 'Ready to review', held: 'Held', skipped: 'Skipped' };
const STATUS_ICON = { submitted: 'send', ready: 'check', held: 'hold', skipped: 'skip' };
export function statusChip(status) {
  return h('span', { class: `status ${status}` }, icon(STATUS_ICON[status] || 'circle', 14), STATUS_LABEL[status] || status);
}
export const statusLabel = (s) => STATUS_LABEL[s] || s;

export function emptyState({ iconName = 'inbox', title, body, action, steps }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'badge' }, icon(iconName, 22)),
    h('h3', {}, title),
    body ? h('p', {}, body) : null,
    steps ? h('ol', { class: 'steps' }, ...steps.map((s) => h('li', {}, h('span', {}, s)))) : null,
    action || null,
  );
}

export function sampleTag() {
  return S.info?.demo ? h('span', { class: 'sample-tag' }, icon('info', 14), 'Sample data') : null;
}

// ---------- warnings ----------
export function warningsCard() {
  const item = (ic, strong, text) => h('li', {}, icon(ic, 18), h('span', {}, h('b', {}, strong), ' ', text));
  return h('section', { class: 'notice', 'aria-labelledby': 'warn-h' },
    h('div', {},
      h('h2', { id: 'warn-h' }, icon('shield', 18), 'Read this once before your first run'),
      h('ul', {},
        item('user', 'Sign in to LinkedIn yourself,', 'in the same Chrome profile that has the Claude extension. The agents use the browser you are already signed in with, and they never see or type your password.'),
        item('link', 'Install the Claude in Chrome extension and sign in to it.', 'Then keep that Chrome window open while a run is going.'),
        item('pause', 'Leave that Chrome profile alone during a run.', 'The agents share it. If you click around in the same window, your clicks and theirs can collide.'),
        item('lock', 'What it will never do:', 'create accounts, type passwords, click CAPTCHAs, read your email, or message anyone for you. Anything it cannot answer honestly is held for you.'),
        item('alert', 'LinkedIn\'s terms restrict automation.', 'Your account could be limited. Start with small batches, use Practice mode first, and you are responsible for everything that is submitted in your name.'),
      ),
    ),
  );
}

// ---------- preflight ----------
const ROW_ICON = { ok: 'check', warn: 'alert', fail: 'x', pending: 'circle' };

export function preflightPanel({ compact = false } = {}) {
  const host = h('div', { class: 'panel' });
  const draw = () => {
    const pf = S.preflight;
    const head = h('div', { class: 'panel-head' },
      h('h2', {}, 'Requirements'),
      h('div', { class: 'page-actions' },
        S.info?.demo ? sampleTag() : null,
        button({ label: 'Re-check', icon: 'refresh', size: 'sm', onClick: () => guard(loadPreflight), loading: S.preflightLoading })),
    );
    let body;
    if (!pf) {
      body = h('div', { class: 'checks' }, ...Array.from({ length: 6 }, () => h('div', { class: 'check-row' }, h('div', { class: 'skeleton', style: { width: '24px', height: '24px', borderRadius: '12px' } }), h('div', { class: 'skeleton', style: { width: '60%' } }))));
    } else {
      body = h('div', { class: 'checks' }, ...pf.rows.map(row));
    }
    mount(host, head, body);
  };

  const row = (r) => {
    const actions = [];
    if (r.id === 'extension') {
      actions.push(button({ label: S.testing ? 'Testing…' : 'Test connection', icon: 'play', size: 'sm', kind: r.status === 'ok' ? '' : 'primary', loading: S.testing, onClick: () => guard(async () => {
        const res = await testConnection();
        toast(res.ok ? 'Chrome is connected.' : 'Could not reach Chrome. See the fix below.', res.ok ? 'ok' : 'bad');
      }) }));
      if (r.status !== 'ok') actions.push(button({ label: 'Get the extension', icon: 'external', size: 'sm', onClick: () => guard(() => POST('/api/open', { target: 'extension' })) }));
    }
    if (r.id === 'linkedin') {
      actions.push(button({ label: 'Open LinkedIn', icon: 'external', size: 'sm', onClick: () => guard(async () => { const o = await POST('/api/open', { target: 'linkedin' }); toast(`Opened in ${o.opened}. Sign in there if you are not already.`); }) }));
    }
    const extra = r.id === 'linkedin' ? h('label', { class: 'check extra' },
      h('input', { type: 'checkbox', checked: r.status === 'ok', onChange: (e) => guard(() => confirmLinkedin(e.target.checked)) }),
      h('span', {}, h('b', {}, 'I am signed in to LinkedIn'), ' in the same Chrome profile that has the Claude extension. ', h('span', { class: 'faint' }, 'This tool never asks for or stores your LinkedIn password.')),
    ) : null;
    const showFix = r.status !== 'ok' && r.hint;
    return h('div', { class: 'check-row' },
      h('div', { class: `ic ${r.status}` }, icon(ROW_ICON[r.status] || 'circle', 14)),
      h('div', {},
        h('div', { class: 'title' }, r.title),
        h('div', { class: 'sum' }, r.summary),
        showFix ? h('div', { class: 'fix' }, r.hint) : null,
      ),
      h('div', { class: 'actions' }, ...actions),
      extra,
    );
  };

  on('preflight', draw);
  draw();
  if (!S.preflight && !S.preflightLoading) loadPreflight().catch((e) => toast(e.message, 'bad'));
  return host;
}
