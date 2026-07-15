// render/theme.js
// Theme toggle (dark default + light "field-notebook"), persisted in localStorage under
// aeon.theme. Pure DOM/CSS-variable manipulation; no sim coupling.

const KEY = 'aeon.theme';

export function initTheme() {
  let theme = 'dark';
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') theme = stored;
  } catch (_) {
    /* localStorage may be blocked; default dark */
  }
  applyTheme(theme);
  return theme;
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch (_) {
    /* ignore */
  }
}

export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const next = cur === 'light' ? 'dark' : 'light';
  applyTheme(next);
  return next;
}

// Read a resolved CSS custom property as an [r,g,b] triple for canvas/WebGL use.
export function cssColor(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return parseColor(v);
}

export function parseColor(str) {
  str = str.trim();
  if (str.startsWith('#')) {
    let hex = str.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /rgba?\(([^)]+)\)/.exec(str);
  if (m) {
    const parts = m[1].split(',').map((s) => parseFloat(s));
    return [parts[0] | 0, parts[1] | 0, parts[2] | 0];
  }
  return [255, 255, 255];
}
