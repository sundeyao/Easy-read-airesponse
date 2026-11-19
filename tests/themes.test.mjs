import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/themes.js';

const { PRESETS, normalize, palette, contrast } = globalThis.FoldThemes;

test('old preferences migrate to neutral and invalid stored colors cannot become CSS', () => {
  assert.equal(normalize().preset, 'neutral');
  assert.equal(normalize('unknown').preset, 'neutral');
  const custom = normalize({ preset: 'custom', background: 'url(https://example.invalid)', accent: '#fff; color:red' });
  assert.equal(custom.background, '#f3f4f6');
  assert.equal(custom.accent, '#526176');
  assert.equal(normalize({ preset: 'custom', background: '#ABCDEF', accent: '#123456' }).background, '#abcdef');
});

test('light, dark and custom palettes keep readable text across reading surfaces', () => {
  const backgrounds = ['#000000', '#191d25', '#747474', '#757575', '#777777', '#808080', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff'];
  const accents = ['#000000', '#ffffff', '#ffff00', '#00ffff', '#ff00ff', '#ff0000', '#00ff00', '#0000ff'];
  const samples = [...PRESETS.map(p => p.id), ...backgrounds.flatMap(background => accents.map(accent => ({ preset: 'custom', background, accent })))];
  for (const sample of samples) {
    const { colors } = palette(sample);
    for (const surface of ['--canvas', '--surface', '--card', '--field', '--selected', '--hover']) {
      for (const foreground of ['--ink', '--muted', '--accent-text']) assert.ok(contrast(colors[foreground], colors[surface]) >= 4.5, `${JSON.stringify(sample)} ${foreground} on ${surface}`);
    }
    for (const surface of ['--card', '--selected', '--soft', '--code-bg']) assert.ok(contrast(colors['--body-text'], colors[surface]) >= 4.5, `${JSON.stringify(sample)} body on ${surface}`);
    for (const surface of ['--code-bg', '--code-inline']) assert.ok(contrast(colors['--code-text'], colors[surface]) >= 4.5, `${JSON.stringify(sample)} code on ${surface}`);
    assert.ok(contrast(colors['--on-accent'], colors['--accent']) >= 4.5, `${JSON.stringify(sample)} active badge`);
  }
});
