// Theme vor dem ersten Paint setzen (kein weißes Aufblitzen). Gleicher Schlüssel und gleiche Auflösung wie applyTheme in src/lib/auth.tsx.
// Als eigene Datei statt inline, weil die CSP nur script-src 'self' erlaubt.
(function () {
  var stored = null;
  try { stored = localStorage.getItem('pt_theme'); } catch (e) { /* Speicher gesperrt */ }
  var dark = stored === 'dark' || (stored !== 'light' && !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
