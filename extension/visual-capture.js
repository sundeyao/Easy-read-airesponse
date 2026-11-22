/* Capture only diagram/image subtrees inside an already-recognized message.
   No page screenshot, network requests, cookies, or page JavaScript execution. */
(() => {
  const VERSION = '1.2.6';
  if (globalThis.FoldVisualCapture?.version === VERSION) return;
  const HTML = 'http://www.w3.org/1999/xhtml', SVG = 'http://www.w3.org/2000/svg';
  const OMIT = 'script,style,link,meta,button,form,input,textarea,select,iframe,object,embed,video,audio,[contenteditable="true"],[role="textbox"],[hidden],.sr-only,[data-markdown-text-tone="tertiary"]';
  const HTML_TAGS = new Set(['div', 'span', 'p', 'section', 'article', 'figure', 'figcaption', 'strong', 'b', 'em', 'i', 'small', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'pre', 'code', 'blockquote']);
  const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'marker', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'title', 'desc', 'symbol', 'use', 'foreignObject']);
  const ATTRS = new Set(['id', 'viewBox', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points', 'fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity', 'opacity', 'transform', 'preserveAspectRatio', 'text-anchor', 'dominant-baseline', 'font-size', 'font-weight', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'colspan', 'rowspan']);
  const STYLE = ['display', 'box-sizing', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-radius', 'background-color', 'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'white-space', 'word-break', 'overflow-wrap', 'vertical-align', 'list-style-type', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'align-items', 'align-self', 'justify-content', 'gap', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'place-items', 'position', 'top', 'right', 'bottom', 'left', 'overflow', 'opacity', 'transform', 'transform-origin', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];
  const cache = new WeakMap();
  const imageCache = new WeakMap();
  const trim = text => text.replace(/\n{3,}/g, '\n\n').trim();
  const hash = text => { let value = 2166136261; for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619); return (value >>> 0).toString(36); };
  const clearColor = color => !color || color === 'transparent' || /rgba\([^)]*,\s*0\s*\)/.test(color);
  function textOf(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || node.matches(OMIT)) return '';
    const css = getComputedStyle(node); if (css.display === 'none' || css.visibility === 'hidden' || css.opacity === '0') return '';
    const text = Array.from(node.childNodes, textOf).join('');
    return /^(DIV|P|SECTION|H[1-6]|LI|TR|FIGCAPTION)$/.test(node.tagName) ? '\n' + text + '\n' : text;
  }
  function visible(node) { const css = getComputedStyle(node); return !node.closest(OMIT) && css.display !== 'none' && css.visibility !== 'hidden'; }
  function framed(node) {
    const css = getComputedStyle(node);
    return parseFloat(css.borderRadius) >= 4 && ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].some(key => parseFloat(css[key]) > 0);
  }
  function containsSections(node, parts) {
    // Native code panels have colored rounded frames and toolbar SVG icons too.
    // They must remain source code, never a diagram that omits textbox contents.
    if (node.querySelector('.cm-content')) return true;
    const headings = Array.from(node.querySelectorAll('h1,h2,h3')).filter(heading => visible(heading) && !parts.some(part => part.contains(heading)));
    if (!headings.length) return false;
    // A bordered diagram can have its own title above its panels. That title
    // belongs in the image; several headings or a heading between panels mark
    // separate prose sections and must prevent capturing their shared parent.
    if (headings.length !== 1 || !framed(node)) return true;
    const first = parts.reduce((a, b) => a.compareDocumentPosition(b) & 4 ? a : b);
    return !(headings[0].compareDocumentPosition(first) & 4) || headings[0].getBoundingClientRect().bottom > first.getBoundingClientRect().top + 2;
  }
  function detect(root) {
    const found = new Set();
    const nativeBox = '[data-d-component="box"][data-d-has-border]';
    const explicit = '[data-fold-diagram],[data-mermaid],.mermaid,[data-testid*="diagram"],[data-testid*="visualization"],' + nativeBox + ',figure';
    for (const node of [...(root.matches(explicit) ? [root] : []), ...root.querySelectorAll(explicit)]) {
      // This is a declared box boundary, including transparent text-only frames.
      // Editable/native code panels keep using the code-text capture path.
      if (node.matches(nativeBox) && (node.querySelector('pre,.cm-editor,.cm-content') || node.getBoundingClientRect().height < 20)) continue;
      if (visible(node) && !node.closest('pre') && node.getBoundingClientRect().width >= 80 && (node.querySelector('svg,canvas,img') || node.matches(explicit.replace(',figure', '')))) found.add(node);
    }
    // HTML diagrams often contain several colored cards inside one rounded frame.
    // Infer that frame from repeated panels + icons/arrows, never the whole answer.
    const styled = Array.from(root.querySelectorAll('div,section')).filter(node => {
      if (!visible(node) || node.closest('pre,table')) return false;
      const box = node.getBoundingClientRect(), css = getComputedStyle(node);
      return box.width >= 100 && box.height >= 38 && !clearColor(css.backgroundColor) && parseFloat(css.borderRadius) >= 4;
    });
    const panels = styled.filter(node => !styled.some(child => child !== node && node.contains(child) && child.getBoundingClientRect().width > node.getBoundingClientRect().width * 0.65));
    for (const panel of panels) {
      let owner = panel.parentElement;
      for (let depth = 0; owner && owner !== root && depth < 4; depth++, owner = owner.parentElement) {
        if (owner.matches('pre,code,table')) continue;
        const parts = panels.filter(other => owner.contains(other));
        if (parts.length < 2 || containsSections(owner, parts)) continue;
        const icons = owner.querySelectorAll('svg').length;
        if (icons < 2 && !/[↓↑→←⇣⇡↔↻↺⟳⟲↩↪⇢⇒⇨↘↗]/.test(textOf(owner))) continue;
        const css = getComputedStyle(owner);
        if (parseFloat(css.borderRadius) >= 4 || parseFloat(css.borderTopWidth) > 0 || css.display === 'grid' || css.display === 'flex') { found.add(owner); break; }
      }
    }
    for (const node of root.querySelectorAll('img,canvas,svg')) {
      if (!visible(node) || node.closest('pre') || [...found].some(parent => parent.contains(node))) continue;
      const box = node.getBoundingClientRect();
      if (node.tagName.toLowerCase() === 'svg' && (box.width < 100 || box.height < 55)) continue;
      if (box.width >= 40 && box.height >= 25) found.add(node);
    }
    // A diagram can have several internal flex/grid groups. Prefer their shared
    // outer frame over those fragments, while leaving separate sections alone.
    for (const piece of [...found]) {
      for (let frame = piece.parentElement, depth = 0; frame && frame !== root && depth < 10; frame = frame.parentElement, depth++) {
        const pieces = [...found].filter(other => frame.contains(other));
        if (pieces.length < 2 || !visible(frame) || frame.matches('pre,code,table')) continue;
        if (pieces.some(part => part.matches(nativeBox)) && !frame.matches(nativeBox)) continue;
        if (!framed(frame) || containsSections(frame, pieces)) continue;
        found.add(frame);
      }
    }
    return [...found].filter(node => ![...found].some(parent => parent !== node && parent.contains(node)));
  }
  function localImage(node) {
    try {
      if (node.tagName.toLowerCase() === 'img' && (!node.complete || !node.naturalWidth)) return null;
      const width = node.naturalWidth || node.width, height = node.naturalHeight || node.height;
      if (!width || !height) return null;
      const canvas = document.createElement('canvas'), box = node.getBoundingClientRect();
      const signature = [node.currentSrc, width, height, box.width, box.height, node.crossOrigin].join(':');
      if (node.localName === 'img' && imageCache.get(node)?.signature === signature) return imageCache.get(node).image;
      let scale = Math.min(1, 1800 / width, 2400 / height, Math.sqrt(3_000_000 / (width * height)));
      for (let attempt = 0; attempt < 4; attempt++) {
        canvas.width = Math.max(1, Math.ceil(width * scale)); canvas.height = Math.max(1, Math.ceil(height * scale));
        canvas.getContext('2d').drawImage(node, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/png');
        if (data.length <= 1_200_000) { const image = { data, width: Math.ceil(box.width), height: Math.ceil(box.height) }; if (node.localName === 'img') imageCache.set(node, { signature, image }); return image; }
        scale *= 0.65;
      }
      return null;
    } catch { return null; } // CORS-tainted images remain labeled fallbacks.
  }
  function clone(node, budget, root = false) {
    if (--budget.nodes < 0) throw new Error('Diagram is too complex');
    if (node.nodeType === 3) return document.createTextNode(node.textContent);
    if (node.nodeType !== 1 || node.matches(OMIT) || !visible(node)) return null;
    const tag = node.localName;
    if (tag === 'img' || tag === 'canvas') {
      const image = localImage(node);
      if (!image) { const span = document.createElementNS(HTML, 'span'); span.textContent = '[图片无法复制，请在原对话查看]'; return span; }
      const copy = document.createElementNS(HTML, 'img'); copy.setAttribute('src', image.data); copy.setAttribute('alt', node.alt || '图片');
      const rect = node.getBoundingClientRect(); copy.style.width = rect.width + 'px'; copy.style.height = rect.height + 'px'; return copy;
    }
    const svg = node.namespaceURI === SVG;
    const copy = document.createElementNS(svg ? SVG : HTML, svg ? (SVG_TAGS.has(tag) ? tag : 'g') : (HTML_TAGS.has(tag) ? tag : 'div'));
    if (svg && !SVG_TAGS.has(tag)) return null;
    for (const attr of node.attributes) {
      if (ATTRS.has(attr.name) && !/url\(|javascript:|data:|https?:/i.test(attr.value)) copy.setAttribute(attr.name, attr.value);
      if (svg && ['marker-start', 'marker-mid', 'marker-end', 'clip-path', 'mask', 'fill', 'stroke'].includes(attr.name) && /^url\(#[\w:.-]+\)$/.test(attr.value)) copy.setAttribute(attr.name, attr.value);
      if (svg && (attr.name === 'href' || attr.name === 'xlink:href') && /^#[\w:.-]+$/.test(attr.value)) copy.setAttribute('href', attr.value);
    }
    const css = getComputedStyle(node);
    for (const property of STYLE) {
      let value = css.getPropertyValue(property);
      if (/url\(/i.test(value)) { if (/^url\(["']?(?:https?:[^#]*?)?#([\w:.-]+)["']?\)$/.test(value)) value = 'url(#' + value.match(/#([\w:.-]+)/)[1] + ')'; else continue; }
      if (value && !/expression\(|javascript:|@import/i.test(value)) copy.style.setProperty(property, value);
    }
    if (root) {
      const rect = node.getBoundingClientRect(); copy.style.width = Math.ceil(rect.width) + 'px'; copy.style.height = Math.ceil(rect.height) + 'px';
      copy.style.boxSizing = 'border-box'; copy.style.minWidth = '0'; copy.style.maxWidth = 'none'; copy.style.margin = '0'; copy.style.position = 'relative'; copy.style.top = 'auto'; copy.style.left = 'auto'; copy.style.transform = 'none';
    }
    for (const child of node.childNodes) { const cloned = clone(child, budget); if (cloned) copy.append(cloned); }
    return copy;
  }
  function backdrop(node) {
    for (let el = node; el; el = el.parentElement) { const color = getComputedStyle(el).backgroundColor; if (!clearColor(color)) return color; }
    return getComputedStyle(node).color.match(/rgb\((\d+)/)?.[1] > 150 ? '#111111' : '#ffffff';
  }
  async function capture(node) {
    const rect = node.getBoundingClientRect(), tag = node.localName;
    const text = trim(textOf(node)).slice(0, 12000) || node.getAttribute('aria-label') || node.alt || '图示';
    if (tag === 'img' || tag === 'canvas') {
      const image = localImage(node);
      if (!image) return { id: 'visual-' + hash(text + (node.currentSrc || '')), kind: 'unavailable', text, reason: '这张图片尚未加载或受浏览器跨域限制，请在原对话查看。' };
      return { id: 'visual-' + hash(image.data), kind: 'image', text, ...image };
    }
    if (rect.width > 4000 || rect.height > 10000 || rect.width * rect.height > 12_000_000) return { id: 'visual-' + hash(text), kind: 'unavailable', text, reason: '图示过大，请在原对话查看。' };
    try {
      const copy = clone(node, { nodes: 1600 }, true);
      const width = Math.ceil(rect.width), height = Math.ceil(rect.height);
      const wrapper = document.createElementNS(HTML, 'div'); wrapper.style.width = width + 'px'; wrapper.style.height = height + 'px'; wrapper.style.backgroundColor = backdrop(node); wrapper.append(copy);
      const html = new XMLSerializer().serializeToString(wrapper);
      const svg = `<svg xmlns="${SVG}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%">${html}</foreignObject></svg>`;
      if (svg.length > 650000) throw new Error('Diagram snapshot is too large');
      const old = cache.get(node); if (old?.source === svg) return old.asset;
      // Rasterize in the reader's extension document, not the source page.
      // Source-page img-src policies can reject even a locally created SVG.
      const data = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
      const asset = { id: 'visual-' + hash(svg), kind: 'diagram', data, width, height, text };
      cache.set(node, { source: svg, asset }); return asset;
    } catch { return { id: 'visual-' + hash(text), kind: 'unavailable', text, reason: '此图示暂时无法完整复制，请在原对话查看。' }; }
  }
  globalThis.FoldVisualCapture = { version: VERSION, detect, capture };
})();
