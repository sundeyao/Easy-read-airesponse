/* Local theme preferences only. Loaded before CSS to restore the palette early. */
(() => {
  const PRESETS = Object.freeze([
    { id: 'neutral', label: '简洁白', background: '#f3f4f6', accent: '#526176' },
    { id: 'warm', label: '暖纸色', background: '#f3ecdf', accent: '#93623f' },
    { id: 'blue', label: '雾蓝', background: '#eaf0f8', accent: '#436d9b' },
    { id: 'purple', label: '浅紫', background: '#f1edf7', accent: '#795b98' },
    { id: 'dark', label: '深色', background: '#191d25', accent: '#9aacf0' },
    { id: 'green', label: '经典绿', background: '#f3f5ee', accent: '#587842' }
  ]);
  const CACHE = 'fold-theme:v1';
  const hex = (value, fallback) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
  const rgb = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const mix = (a, b, weight) => '#' + rgb(a).map((n, i) => Math.round(n * (1 - weight) + rgb(b)[i] * weight).toString(16).padStart(2, '0')).join('');
  function luminance(color) {
    const values = rgb(color).map(n => n / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  }
  function contrast(a, b) { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + 0.05) / (values[1] + 0.05); }
  function readable(candidate, backgrounds, minimum = 4.5) {
    const score = value => Math.min(...backgrounds.map(bg => contrast(value, bg)));
    if (score(candidate) >= minimum) return candidate;
    const target = score('#000000') > score('#ffffff') ? '#000000' : '#ffffff';
    for (let step = 1; step <= 100; step++) { const value = mix(candidate, target, step / 100); if (score(value) >= minimum) return value; }
    return target;
  }
  function normalize(value) {
    const preset = PRESETS.find(p => p.id === (typeof value === 'string' ? value : value?.preset));
    if (preset) return { preset: preset.id, background: preset.background, accent: preset.accent };
    if (value?.preset === 'custom') return { preset: 'custom', background: hex(value.background, PRESETS[0].background), accent: hex(value.accent, PRESETS[0].accent) };
    return { preset: PRESETS[0].id, background: PRESETS[0].background, accent: PRESETS[0].accent };
  }
  function palette(value) {
    const theme = normalize(value), canvas = theme.background;
    const dark = contrast('#ffffff', canvas) >= contrast('#000000', canvas);
    const subtle = amount => dark ? mix(canvas, luminance(canvas) < 0.08 ? '#ffffff' : '#000000', amount) : mix(canvas, '#ffffff', amount);
    const surface = subtle(dark ? 0.035 : 0.55), card = subtle(dark ? 0.07 : 0.98), field = subtle(dark ? 0.045 : 0.85);
    const base = [canvas, surface, card, field];
    const ink = readable(dark ? '#f0f3f8' : '#252b35', base);
    const tint = (background, amount) => {
      for (let step = 0; step < 10; step++) {
        const color = mix(background, theme.accent, amount / 2 ** step);
        if (contrast(ink, color) >= 4.5) return color;
      }
      return background;
    };
    const selected = tint(card, dark ? 0.16 : 0.11), hover = tint(surface, dark ? 0.13 : 0.08);
    const surfaces = [...base, selected, hover];
    const muted = readable(dark ? '#a2acbd' : '#707b8b', surfaces);
    const accent = readable(theme.accent, surfaces, 3), onAccent = readable('#ffffff', [accent]);
    const code = dark ? mix(card, '#000000', 0.12) : mix(canvas, '#ffffff', 0.12);
    const warningBackground = dark ? '#352c20' : '#fff6e9';
    return {
      theme, dark,
      colors: {
        '--canvas': canvas, '--surface': surface, '--card': card, '--field': field,
        '--ink': ink, '--body-text': readable(mix(ink, card, 0.12), [...surfaces, code, tint(card, 0.045)]), '--muted': muted,
        '--line': mix(surface, ink, dark ? 0.19 : 0.14), '--line-soft': mix(card, ink, dark ? 0.13 : 0.1),
        '--accent': accent, '--accent-text': readable(theme.accent, surfaces), '--on-accent': onAccent,
        '--selected': selected, '--hover': hover, '--panel': tint(surface, 0.045), '--soft': tint(card, 0.045),
        '--scroll': mix(surface, ink, 0.25), '--dots': mix(canvas, ink, dark ? 0.14 : 0.12),
        '--code-bg': code, '--code-inline': dark ? mix(code, '#000000', 0.08) : tint(code, 0.06),
        '--code-text': readable(ink, [code, dark ? mix(code, '#000000', 0.08) : tint(code, 0.06)]),
        '--quote-line': mix(card, accent, 0.5), '--success': dark ? '#80bf8d' : '#42814d',
        '--status-idle': mix(surface, ink, 0.35), '--warning': readable(dark ? '#edbb7b' : '#9b642c', [surface, warningBackground]),
        '--warning-bg': warningBackground, '--warning-line': dark ? '#806642' : '#d9ba8e',
        '--toast-bg': dark ? '#e2e8f0' : '#293343', '--toast-text': dark ? '#1a202b' : '#ffffff',
        '--shadow': dark ? '0 8px 36px #00000030' : '0 8px 36px #1720330c',
        '--popup-shadow': dark ? '0 8px 36px #00000070' : '0 8px 36px #17203324'
      }
    };
  }
  function loadCached() { try { return normalize(JSON.parse(localStorage.getItem(CACHE))); } catch { return normalize(); } }
  function apply(value, { cache = true } = {}) {
    const result = palette(value);
    if (typeof document !== 'undefined') {
      for (const [name, color] of Object.entries(result.colors)) document.documentElement.style.setProperty(name, color);
      document.documentElement.style.colorScheme = result.dark ? 'dark' : 'light';
      document.documentElement.dataset.theme = result.theme.preset;
      document.documentElement.dataset.themeMode = result.dark ? 'dark' : 'light';
      if (cache) try { localStorage.setItem(CACHE, JSON.stringify(result.theme)); } catch { /* local settings still use chrome.storage */ }
    }
    return result;
  }
  globalThis.FoldThemes = { PRESETS, normalize, palette, contrast, apply, loadCached };
  if (typeof document !== 'undefined') apply(loadCached(), { cache: false });
})();
