// Inline SVG icons (24px grid, 1.75 stroke). Paths are static constants, never user input.
const P = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 3.8l9 15.7H3z"/><path d="M12 10v4.2M12 17.2v.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.1"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 9l5-5 5 5M5 20h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  chevronR: '<path d="M9 6l6 6-6 6"/>',
  chevronD: '<path d="M6 9l6 6 6-6"/>',
  chevronU: '<path d="M6 15l6-6 6 6"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1-4 4-6 8-6s7 2 8 6"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  table: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 10h17M9 10v9"/>',
  inbox: '<path d="M4 13l2.5-8h11L20 13v6H4zM4 13h5l1 2h4l1-2h5"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  terminal: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7.5 10l3 2-3 2M13 15h4"/>',
  file: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5V8h4"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/>',
  edit: '<path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17v.1"/>',
  folder: '<path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  circle: '<circle cx="12" cy="12" r="8" stroke-dasharray="2.5 3.5"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/>',
  hold: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  skip: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
};

export function icon(name, size = 16, cls = '') {
  const span = document.createElement('span');
  span.style.display = 'inline-flex';
  span.style.flex = 'none';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return span;
}

export function brandMark(size = 30) {
  const span = document.createElement('span');
  span.setAttribute('aria-hidden', 'true');
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="var(--ink)"/><rect x="7" y="8" width="14" height="3.5" rx="1.75" fill="var(--ink-fg)"/><rect x="7" y="14.25" width="10" height="3.5" rx="1.75" fill="var(--ink-fg)"/><rect x="7" y="20.5" width="12" height="3.5" rx="1.75" fill="var(--ink-fg)"/><circle cx="24" cy="16" r="2.4" fill="var(--accent)"/></svg>`;
  return span;
}
