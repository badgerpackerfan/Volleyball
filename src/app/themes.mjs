const SETTINGS_KEY = 'vb-live-settings';

export const COLOR_THEMES = [
  { id: 'evergreen', name: 'Evergreen', description: 'Pine court · classic green and red', accent: '#286747', court: '#447454', court2: '#356448', set: '#a82e29', oh: '#254fa7', mid: '#17613b', win: '#16713c', lose: '#b3251f' },
  { id: 'blue_hour', name: 'Blue hour', description: 'Slate-blue court · cool green and warm red', accent: '#355e82', court: '#59758b', court2: '#405c72', set: '#a33f36', oh: '#8d5b17', mid: '#246646', win: '#26714c', lose: '#b94e42' },
  { id: 'amethyst', name: 'Amethyst', description: 'Plum court · olive green and berry red', accent: '#70568f', court: '#665c79', court2: '#50465f', set: '#a64250', oh: '#8d5c13', mid: '#286546', win: '#58713f', lose: '#a83d50' },
  { id: 'terracotta', name: 'Terracotta', description: 'Clay court · moss green and brick red', accent: '#914a38', court: '#8c6154', court2: '#704c42', set: '#ae3d33', oh: '#28547b', mid: '#286545', win: '#427143', lose: '#b34b33' },
];

export function colorTheme(themeId) {
  return COLOR_THEMES.find(theme => theme.id === themeId) || COLOR_THEMES[0];
}

// Older rosters stored an arbitrary team accent. Pick the nearest available
// palette when reading those records so their new team theme starts sensibly.
export function inferColorTheme(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color || '')?.[1];
  if (!hex) return COLOR_THEMES[0];
  const rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  return COLOR_THEMES.reduce((best, theme) => {
    const candidate = theme.accent.slice(1);
    const distance = [0, 2, 4].reduce((sum, i, channel) => {
      const delta = rgb[channel] - parseInt(candidate.slice(i, i + 2), 16);
      return sum + delta * delta;
    }, 0);
    return distance < best.distance ? { theme, distance } : best;
  }, { theme: COLOR_THEMES[0], distance: Infinity }).theme;
}

export const DEFAULT_SETTINGS = { labels: 'words', appearance: 'device', theme: 'evergreen', corner: true, categories: {} };
const RENAMED_THEMES = { sage: 'evergreen', redwood: 'terracotta', night: 'blue_hour' };

export function loadSettings(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(SETTINGS_KEY) || '{}') || {};
    const theme = RENAMED_THEMES[saved.theme] || saved.theme;
    return { ...DEFAULT_SETTINGS, ...saved, theme };
  }
  catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(settings)); return true; }
  catch { return false; }
}

export function applyColorTheme(themeId, doc = globalThis.document) {
  const theme = COLOR_THEMES.find(t => t.id === themeId) || COLOR_THEMES[0];
  const root = doc?.documentElement;
  if (!root) return theme;
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--court', theme.court);
  root.style.setProperty('--court-2', theme.court2);
  root.style.setProperty('--c-set', theme.set);
  root.style.setProperty('--c-oh', theme.oh);
  root.style.setProperty('--c-mid', theme.mid);
  root.style.setProperty('--win', theme.win);
  root.style.setProperty('--lose', theme.lose);
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.accent);
  return theme;
}
