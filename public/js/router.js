// A hash router: #/  #/applications  #/input  #/settings/<tab>  #/setup/<step>
export function parseRoute(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name: parts[0] || 'dashboard', arg: parts[1] || '' };
}

export function go(path) {
  const target = '#' + (path.startsWith('/') ? path : '/' + path);
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = target;
}
