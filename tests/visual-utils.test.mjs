import test from 'node:test';
import assert from 'node:assert/strict';
import { visualFormat } from '../extension/visual-utils.js';
const svg = content => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${content}</div></foreignObject></svg>`).toString('base64');
test('only self-contained visual snapshots are accepted', () => {
  assert.equal(visualFormat(svg('<p style="color:rgb(1,2,3)">图示</p>')), 'svg');
  assert.equal(visualFormat(svg('<svg xmlns="http://www.w3.org/2000/svg"><use href="#symbol"/></svg>')), 'svg');
  assert.equal(visualFormat(svg('<p style="clip-path:url(&quot;#clip&quot;)">图示</p>')), 'svg');
  for (const content of ['<script>alert(1)</script>', '<img src="https://example.invalid/tracker">', '<div onclick="alert(1)">x</div>', '<style>body{color:red}</style>', '<iframe src="about:blank"/>', '<div style="background:url(https://example.invalid/image)">x</div>']) assert.equal(visualFormat(svg(content)), null, content);
  assert.equal(visualFormat('https://example.invalid/image.png'), null);
  assert.equal(visualFormat('data:image/png;base64,PHN2Zy8+'), null);
});
