import { h, get, set, mount } from './dom.js';
import { icon } from './icons.js';
import { S, markDirty, loadPreflight, testConnection, confirmLinkedin, on, loadSetup, emit } from './state.js';
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

// ---------- confirm dialog ----------
/**
 * A modal that resolves true on the confirm button and false otherwise.
 * `body` is an array of DOM nodes. Focus starts on Cancel so Enter never confirms by accident.
 */
export function confirmDialog({ title, body = [], confirmLabel = 'Continue', confirmIcon = null, kind = 'primary' }) {
  return new Promise((resolve) => {
    const cancel = button({ label: 'Cancel', onClick: () => dlg.close('no') });
    const dlg = h('dialog', { 'aria-labelledby': 'dlg-h' },
      h('div', { class: 'd-body' }, h('h2', { id: 'dlg-h' }, title), ...body),
      h('div', { class: 'd-foot' }, cancel, button({ label: confirmLabel, icon: confirmIcon, kind, onClick: () => dlg.close('yes') })));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'yes'); dlg.remove(); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('no'); });
    document.body.append(dlg);
    dlg.showModal();
    cancel.focus();
  });
}

// ---------- form fields ----------
let uid = 0;
const nextId = () => `f${++uid}`;

export function field(label, control, { hint, required, span, id } = {}) {
  const target = control.matches('input,select,textarea') ? control : control.querySelector('input,select,textarea');
  const fid = id || target?.id || nextId();
  if (target && !target.id) target.id = fid;
  if (target && hint) target.setAttribute('aria-describedby', `${fid}-hint`);
  if (target && required === true) target.setAttribute('aria-required', 'true');
  return h('div', { class: `field ${span ? 'span-2' : ''}` },
    label ? h('label', { for: fid }, label, required === true ? h('span', { class: 'req' }, 'Required') : null) : null,
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

export function textArea(path, { placeholder, rows = 3, label } = {}) {
  const el = h('textarea', { class: 'textarea', rows, placeholder, 'aria-label': label });
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

const fmt = (v) => (v === '' || v == null ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));

/**
 * A number field. `decimals: 2` allows cents (pay per hour). Shows thousands separators once you leave it.
 * `min` and `max` are applied when you leave the field, and the box shows the number that will really be saved.
 * Optional $ prefix and a suffix like "per year".
 */
export function numberInput(path, { placeholder, prefix, suffix, label, grouped = false, decimals = 0, min, max } = {}) {
  const el = h('input', { class: 'input', type: 'text', inputmode: decimals ? 'decimal' : 'numeric', placeholder, 'aria-label': label });
  const show = (v) => (grouped ? fmt(v) : String(v ?? ''));
  el.value = show(get(S.draft, path));
  el.addEventListener('input', () => {
    let text = el.value.replace(decimals ? /[^\d.]/g : /[^\d]/g, '');
    if (decimals) {
      const [whole, ...rest] = text.split('.');
      text = rest.length ? `${whole}.${rest.join('').slice(0, decimals)}` : whole;
    }
    const n = text === '' || text === '.' ? '' : Number(text);
    set(S.draft, path, n);
    markDirty();
  });
  el.addEventListener('blur', () => {
    let v = get(S.draft, path);
    if (v !== '' && v != null) {
      if (max != null && v > max) v = max;
      if (min != null && v < min) v = min;
      set(S.draft, path, v);
    }
    el.value = show(v);
  });
  if (!prefix && suffix == null) return el;
  const suffixEl = suffix != null ? h('span', { class: 'suffix', 'aria-hidden': 'true' }, suffix) : null;
  const wrap = h('div', { class: `input-affix ${suffixEl ? 'has-suffix' : ''}` }, prefix ? h('span', { class: 'affix', 'aria-hidden': 'true' }, prefix) : null, el, suffixEl);
  wrap.setSuffix = (t) => { if (suffixEl) suffixEl.textContent = t; };
  return wrap;
}

/** Run a redraw and put keyboard focus back on the same button position, so Space, Tab and arrows keep working. */
function keepFocus(container, redraw, { fallback } = {}) {
  const buttons = () => [...container.querySelectorAll('button')];
  const idx = buttons().indexOf(document.activeElement);
  redraw();
  if (idx >= 0) (buttons()[idx] || fallback || buttons().at(-1))?.focus();
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
          keepFocus(wrap, draw);
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
      h('button', { type: 'button', 'aria-label': `Remove ${t}`, onClick: () => { set(S.draft, path, get(S.draft, path).filter((x) => x !== t)); markDirty(); keepFocus(list, draw, { fallback: input }); if (!list.querySelector('button')) input.focus(); } }, icon('x', 12)))));
  };
  const add = () => {
    // Pasting "a, b, c" adds three titles.
    const parts = input.value.split(',').map((x) => x.trim()).filter(Boolean);
    if (!parts.length) { input.value = ''; return; }
    let cur = get(S.draft, path) || [];
    for (const v of parts) if (!cur.some((x) => x.toLowerCase() === v.toLowerCase())) cur = [...cur, v];
    set(S.draft, path, cur);
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
    keepFocus(wrap, () => {
      mount(wrap, ...options.map((o) => h('button', {
        type: 'button', 'aria-pressed': String(o.value === v),
        onClick: () => { draw(o.value); onChange(o.value); },
      }, o.label, o.count != null ? h('span', { class: 'count' }, o.count) : null)));
    });
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
    if (file.size > 10 * 1024 * 1024) { toast(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 10 MB. Try saving a smaller PDF.`, 'bad'); return; }
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

// ---------- notes about your saved data ----------
/** Plain-language problems the app found with the saved data (an unreadable file, a missing resume). Empty when all is well. */
export function dataWarnings() {
  const items = S.info?.warnings || [];
  if (!items.length) return null;
  return h('div', { class: 'stack', style: { gap: '8px' }, role: 'status' },
    ...items.map((w) => h('div', { class: 'inline-alert' }, icon('alert', 18), h('div', {}, w.text))));
}

// ---------- warnings ----------
export function warningsCard() {
  const item = (ic, strong, text, cls = '') => h('li', { class: cls }, icon(ic, 18), h('span', {}, h('b', {}, strong), ' ', text));
  return h('section', { class: 'notice', 'aria-labelledby': 'warn-h' },
    h('div', {},
      h('h2', { id: 'warn-h' }, icon('shield', 18), 'Read this once before your first run'),
      h('ul', {},
        item('alert', "LinkedIn's terms restrict automation.", 'Your account could be limited or restricted. Start with small batches, use Practice mode first, and remember you are responsible for everything submitted in your name.', 'lead'),
        item('user', 'Sign in to LinkedIn yourself,', 'in the same Chrome profile that has the Claude extension installed and signed in. The agents never see or type your password.'),
        item('monitor', 'Leave that Chrome window alone during a run.', 'The agents share it, so your clicks and theirs can collide. Keep it open until the run finishes.'),
      ),
    ),
  );
}

// ---------- preflight ----------
const ROW_ICON = { ok: 'check', warn: 'alert', fail: 'x', pending: 'circle' };

export function preflightPanel({ flat = false } = {}) {
  const host = h('div', { class: flat ? 'flat' : 'panel' });
  const draw = () => {
    const pf = S.preflight;
    const recheck = button({ label: 'Re-check', icon: 'refresh', size: 'sm', onClick: () => guard(loadPreflight), loading: S.preflightLoading });
    const head = flat
      ? h('div', { class: 'flat-head' }, h('h3', { class: 'section-title' }, 'Requirements'), recheck)
      : h('div', { class: 'panel-head' }, h('h2', {}, 'Requirements'), recheck);
    const claudeInstalled = pf?.rows?.find((x) => x.id === 'claude')?.status === 'ok';
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
    const running = S.setupJob.status === 'running';
    if (r.id === 'claude' && r.status !== 'ok') {
      actions.push(button({ label: 'Install Claude Code', icon: 'download', size: 'sm', kind: 'primary', disabled: running, onClick: () => guard(installClaude) }));
      actions.push(button({ label: 'Official steps', icon: 'external', size: 'sm', href: r.url || 'https://code.claude.com/docs/en/quickstart', target: '_blank' }));
    }
    if (r.id === 'auth' && r.status !== 'ok' && S.preflight?.rows?.find((x) => x.id === 'claude')?.status === 'ok') {
      actions.push(button({ label: 'Sign in to Claude', icon: 'user', size: 'sm', kind: 'primary', disabled: running, onClick: () => guard(signInToClaude) }));
    }
    if (r.id === 'linkedin') {
      actions.push(button({ label: 'Open LinkedIn', icon: 'external', size: 'sm', onClick: () => guard(async () => { const o = await POST('/api/open', { target: 'linkedin' }); toast(`Opened in ${o.opened}. Sign in there if you are not already.`); }) }));
    }
    const extra = r.id === 'linkedin' ? h('label', { class: 'check extra' },
      h('input', { type: 'checkbox', checked: r.status === 'ok', onChange: (e) => guard(() => confirmLinkedin(e.target.checked)) }),
      h('span', {}, h('b', {}, 'I am signed in to LinkedIn'), ' in the same Chrome profile that has the Claude extension. ', h('span', { class: 'faint' }, 'This tool never asks for or stores your LinkedIn password.')),
    ) : null;
    const showFix = r.status !== 'ok' && r.hint;
    const job = S.setupJob;
    const mine = (r.id === 'claude' && job.kind === 'install') || (r.id === 'auth' && job.kind === 'login');
    // The output stays on screen after a job ends (until you dismiss it), so a quick success can still be read.
    const showTerm = mine && job.lines.length && !job.dismissed;
    return h('div', { class: 'check-row' },
      h('div', { class: `ic ${r.status}` }, icon(ROW_ICON[r.status] || 'circle', 14)),
      h('div', {},
        h('div', { class: 'title' }, r.title),
        h('div', { class: 'sum' }, r.summary),
        showFix ? h('div', { class: 'fix' }, r.hint) : null,
      ),
      h('div', { class: 'actions' }, ...actions),
      extra,
      showTerm ? h('div', { class: 'term-row' }, jobTerminal(job)) : null,
    );
  };

  on('preflight', draw);
  on('setup', () => { draw(); const t = host.querySelector('.term-body'); if (t) t.scrollTop = t.scrollHeight; });
  on('setup-done', (e) => {
    const ok = e.status === 'done';
    toast(ok ? (S.setupJob.kind === 'install' ? 'Claude Code is installed. Checking it now.' : 'Signed in. Checking it now.') : e.status === 'cancelled' ? 'Cancelled.' : 'That did not finish. The output above says why.', ok ? 'ok' : 'bad');
    loadPreflight().catch(() => {});
  });
  draw();
  if (!S.preflight && !S.preflightLoading) loadPreflight().catch((e) => toast(e.message, 'bad'));
  loadSetup().catch(() => {});
  return host;
}

// ---------- install and sign-in (one-click setup) ----------
/** Streams what an install or sign-in prints. Plain text only: it is never parsed as HTML. */
function jobTerminal(job) {
  const running = job.status === 'running';
  const title = job.kind === 'install' ? 'Installing Claude Code' : 'Signing in to Claude';
  const state = running ? 'Working' : job.status === 'failed' ? 'Did not finish' : job.status === 'cancelled' ? 'Cancelled' : 'Done';
  return h('div', { class: 'term', role: 'group', 'aria-label': title },
    h('div', { class: 'term-head' },
      running ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon(job.status === 'failed' ? 'alert' : 'check', 14),
      h('b', {}, title), h('span', { class: 'faint' }, state),
      running ? button({ label: 'Cancel', size: 'sm', kind: 'ghost', onClick: () => guard(() => POST('/api/setup/cancel')) })
        : button({ label: 'Dismiss', size: 'sm', kind: 'ghost', onClick: () => { S.setupJob.dismissed = true; emit('setup'); } })),
    h('div', { class: 'term-body', role: 'log', 'aria-live': 'polite', tabindex: '0' }, ...job.lines.slice(-120).map((l) => h('div', {}, l))),
    running && job.kind === 'install' ? h('div', { class: 'hint' }, 'The installer shows no progress while it downloads. This can take a minute or two.') : null,
    running && job.kind === 'login' ? h('div', { class: 'hint' }, 'A browser window should open. Sign in there with your Claude account. If nothing opens, copy a link from the lines above into your browser.') : null);
}

async function installClaude() {
  const info = S.setup || (await loadSetup());
  const c = info.install;
  const ok = await confirmDialog({
    title: 'Install Claude Code?',
    body: [
      h('p', { class: 'muted' }, `This runs Anthropic's official installer on this computer, in ${c.shell}. It is the same command their setup guide tells you to paste into a terminal:`),
      h('pre', { class: 'cmd' }, c.display),
      h('p', { class: 'hint' }, 'Source: ', h('a', { href: c.source, target: '_blank', rel: 'noopener noreferrer' }, c.source)),
      h('p', { class: 'hint' }, 'It only runs when you press the button below. Nothing else is installed or changed by this app.'),
    ],
    confirmLabel: 'Run the installer', confirmIcon: 'download',
  });
  if (!ok) return;
  S.setupJob = { status: 'running', kind: 'install', lines: [], command: c.display };
  emit('setup');
  const r = await POST('/api/setup/install', { confirm: true });
  S.setupJob = { ...S.setupJob, id: r.job.id };
}

async function signInToClaude() {
  S.setupJob = { status: 'running', kind: 'login', lines: [] };
  emit('setup');
  const r = await POST('/api/setup/login');
  S.setupJob = { ...S.setupJob, id: r.job.id };
}
