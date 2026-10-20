import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const Colors = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../../package/contents/code/colors.js', import.meta.url), 'utf8')
  .replace(/^\.pragma library\s*$/m, ''), Colors);

// Independent calculation of the final, quantized colors; do not validate
// ensureContrast by calling its own contrast function.
function ratio(foreground, background) {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return channels.reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  };
  const [dark, light] = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
  return (light + 0.05) / (dark + 0.05);
}

const themes = [
  { name: 'Breeze Light', surfaces: ['#ffffff', '#eff0f1'], text: '#232629', secondary: '#707d8a',
    states: ['#27ae60', '#f67400', '#da4453', '#2980b9'] },
  { name: 'Breeze Dark', surfaces: ['#141618', '#202326'], text: '#fcfcfc', secondary: '#a1a9b1',
    states: ['#27ae60', '#f67400', '#da4453', '#1d99f3'] },
  { name: 'custom dark palette', surfaces: ['#181b28', '#161925'], text: '#d3dae3', secondary: '#666a73',
    states: ['#71f79f', '#ff6a00', '#ed254e', '#2980b9'] },
  { name: 'pastel desktop theme', surfaces: ['#313239', '#45464b'], text: '#e5e5e5', secondary: '#aaaaaa',
    states: ['#9cc9ab', '#e8c394', '#ed9999', '#a4bde2'] },
  { name: 'mid-gray custom panel', surfaces: ['#777777'], text: '#888888', secondary: '#999999',
    states: ['#2ec059', '#f29c12', '#e62e38', '#5c8aed'] },
];

for (const theme of themes) {
  test(`${theme.name}: informational text and every semantic value reach 4.5:1`, () => {
    for (const background of theme.surfaces) {
      for (const original of [theme.text, theme.secondary, ...theme.states, ...Object.values(Colors.SEMANTIC_COLORS)]) {
        const color = Colors.ensureContrast(original, background, 4.5);
        assert.match(color, /^#[0-9a-f]{6}$/);
        assert.ok(ratio(color, background) >= 4.5, `${color} on ${background}: ${ratio(color, background)}`);
      }
    }
  });
  test(`${theme.name}: bars and their track outline remain distinguishable`, () => {
    for (const background of theme.surfaces) {
      const text = Colors.ensureContrast(theme.text, background, 4.5);
      const track = Colors.blend('#000000', background, 0.16);
      assert.ok(ratio(Colors.ensureContrast(Colors.blend(text, background, 0.4), background, 3), background) >= 3);
      for (const original of [...theme.states, ...Object.values(Colors.SEMANTIC_COLORS)]) {
        const color = Colors.ensureContrast(original, background, 3, track);
        assert.ok(ratio(color, track) >= 3, `${color} on track ${track}`);
        assert.ok(ratio(color, background) >= 3, `${color} on surface ${background}`);
      }
    }
  });
}

test('status colors retain saturation on the gray cards from the pastel desktop theme', () => {
  for (const original of Object.values(Colors.SEMANTIC_COLORS)) {
    const color = Colors.ensureContrast(original, '#45464b', 4.5);
    const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
    const maximum = Math.max(...channels);
    const minimum = Math.min(...channels);
    const saturation = (maximum - minimum) / (1 - Math.abs(maximum + minimum - 1));
    assert.ok(saturation >= 0.7, `${color} lost its saturation: ${saturation}`);
    assert.ok(ratio(color, '#45464b') >= 4.5);
  }
});

test('known contrast references and quantization do not round failing values up', () => {
  assert.equal(Colors.contrast('#000000', '#ffffff'), 21);
  assert.equal(Colors.contrast('#fff', '#fff'), 1);
  assert.ok(Colors.contrast('#777777', '#ffffff') < 4.5);
  const corrected = Colors.ensureContrast('#777777', '#ffffff', 4.5);
  assert.ok(ratio(corrected, '#ffffff') >= 4.5);
});

test('colors already readable stay unchanged and semantic hues adjust to the surface', () => {
  assert.equal(Colors.ensureContrast('#27ae60', '#141618', 4.5), '#27ae60');
  assert.equal(Colors.ensureContrast('#232629', '#ffffff', 4.5), '#232629');
  assert.ok(Colors.luminance(Colors.ensureContrast('#27ae60', '#ffffff', 4.5)) < Colors.luminance('#27ae60'));
  assert.ok(Colors.luminance(Colors.ensureContrast('#ed254e', '#181b28', 4.5)) > Colors.luminance('#ed254e'));
});

test('Qt QColor inputs and alpha produce opaque text with sufficient contrast', () => {
  const background = { r: 24 / 255, g: 27 / 255, b: 40 / 255, a: 1 };
  const foreground = { r: 102 / 255, g: 106 / 255, b: 115 / 255, a: 0.5 };
  const color = Colors.ensureContrast(foreground, background, 4.5);
  assert.ok(ratio(color, '#181b28') >= 4.5);
  assert.equal(Colors.blend('#80ffffff', '#000000'), '#808080');
});
