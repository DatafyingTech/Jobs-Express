try {
  var t = localStorage.getItem('cja-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) { /* storage may be blocked; the system theme still applies */ }
