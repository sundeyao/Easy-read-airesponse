/* Runs in Chrome's isolated content-script world. No network or account APIs. */
(() => {
  const VERSION = '1.2.1';
  if (globalThis.FoldCapture?.version === VERSION) return;
  const allowed = url => { try { const u = new URL(url); return u.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(u.hostname); } catch { return false; } };
  const skipped = 'button,script,style,svg,nav,form,textarea,input,select,[contenteditable="true"],[role="textbox"],[hidden],[aria-hidden="true"],[data-markdown-text-tone="tertiary"],.sr-only';
  const ids = new WeakMap(); let nextId = 0;
  const trim = text => text.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const escape = text => text.replace(/\\/g, '\\\\').replace(/([*_[\]<>])/g, '\\$1');
  const inline = node => Array.from(node.childNodes, serialize).join('');
  let activeVisuals = new WeakMap();
  function serialize(node) {
    if (node.nodeType === 3) return escape(node.textContent);
    if (activeVisuals.has(node)) return '\n\n![原样图示](fold-visual:' + activeVisuals.get(node).id + ')\n\n';
    if (node.nodeType !== 1 || node.matches(skipped)) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'pre') {
      const code = node.querySelector('code') || node;
      const value = code.textContent.replace(/\n$/, '');
      const lang = code.className.match(/language-([\w+-]+)/)?.[1] || '';
      const fence = '`'.repeat(Math.max(3, ...Array.from(value.matchAll(/`+/g), m => m[0].length + 1)));
      return '\n\n' + fence + lang + '\n' + value + '\n' + fence + '\n\n';
    }
    if (tag === 'code') {
      const value = node.textContent;
      const fence = '`'.repeat(Math.max(1, ...Array.from(value.matchAll(/`+/g), m => m[0].length + 1)));
      return fence + ' ' + value + ' ' + fence;
    }
    if (tag === 'table') {
      const rows = Array.from(node.rows, row => Array.from(row.cells, cell => trim(inline(cell)).replace(/\|/g, '\\|').replace(/\n/g, '<br>')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map(row => row.length));
      const line = row => '| ' + Array.from({ length: width }, (_, i) => row[i] || '').join(' | ') + ' |';
      return '\n\n' + [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n') + '\n\n';
    }
    if (tag === 'ul' || tag === 'ol') {
      const start = Number(node.getAttribute('start')) || 1;
      const items = Array.from(node.children).filter(el => el.tagName === 'LI').map((item, i) => {
        const marker = tag === 'ol' ? `${start + i}. ` : '- ';
        return marker + trim(inline(item)).replace(/\n/g, '\n' + ' '.repeat(marker.length));
      });
      return '\n\n' + items.join('\n') + '\n\n';
    }
    if (tag === 'img') return '\n[图片' + (node.alt ? '：' + node.alt : '') + ']\n';
    if (tag === 'video' || tag === 'audio' || tag === 'canvas' || tag === 'iframe') return '\n[媒体内容，请在原对话查看]\n';
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n\n---\n\n';
    const value = inline(node);
    if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + trim(value) + '\n\n';
    if (tag === 'strong' || tag === 'b') return '**' + value + '**';
    if (tag === 'em' || tag === 'i') return '*' + value + '*';
    if (tag === 'del' || tag === 's') return '~~' + value + '~~';
    if (tag === 'a') {
      try { const href = new URL(node.getAttribute('href'), location.href); if (['https:', 'http:', 'mailto:'].includes(href.protocol)) return '[' + value + '](' + href.href.replace(/[()\s]/g, c => encodeURIComponent(c)) + ')'; } catch { /* plain label */ }
      return value;
    }
    if (tag === 'blockquote') return '\n\n' + trim(value).split('\n').map(line => '> ' + line).join('\n') + '\n\n';
    if (['p', 'div', 'section', 'article', 'figure', 'figcaption'].includes(tag)) return '\n\n' + value + '\n\n';
    return value;
  }
  const keyFor = url => { const u = new URL(url); return u.origin + u.pathname.replace(/\/$/, ''); };
  function embedded(document, url) {
    const node = document.getElementById('__WEB_MOBILE_DATA__');
    if (!node || node.type !== 'application/json') return null;
    try {
      const data = JSON.parse(node.textContent);
      // Only the current route's conversation content. Never copy session/auth fields.
      if (!data.canonicalPath || new URL(data.canonicalPath, url).pathname.replace(/\/$/, '') !== new URL(url).pathname.replace(/\/$/, '')) return null;
      const chat = data.conversation;
      if (!chat || !Array.isArray(chat.messages)) return null;
      return { title: typeof chat.title === 'string' ? chat.title : '', messages: chat.messages.flatMap((m, i) => {
        if (!['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') return [];
        return [{ id: String(m.id || `embedded-${i}`), role: m.role, text: m.content.trim() || (m.maskedUploads?.length ? '[附件内容，请在原对话查看]' : '') }];
      }) };
    } catch { return null; }
  }
  const roleSelector = '[data-message-author-role="user"],[data-message-author-role="assistant"],[data-message-role="user"],[data-message-role="assistant"],[data-turn="user"],[data-turn="assistant"]';
  const unitSelector = '[data-content-search-unit-key$=":user"],[data-content-search-unit-key$=":assistant"],[data-chatgpt-search-unit-key$=":user"],[data-chatgpt-search-unit-key$=":assistant"]';
  const bubbleSelector = '[data-user-message-bubble="true"],.user-message-bubble-color,[data-testid="user-message"]';
  const assistantSelector = '[data-markdown-text-style="assistant-message"]:not([data-markdown-text-tone="tertiary"])';
  const turnSelector = '[data-turn-key],[data-turn-id],[data-testid^="conversation-turn-"]';
  const roleOf = node => node.getAttribute('data-message-author-role') || node.getAttribute('data-message-role') || node.getAttribute('data-turn');
  const allWithSelf = (node, selector) => [...(node.matches?.(selector) ? [node] : []), ...node.querySelectorAll(selector)];
  const outermost = nodes => nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
  function messageId(node, role) {
    if (!ids.has(node)) ids.set(node, `visible-${++nextId}`);
    const owner = node.closest('[data-chatgpt-search-message-ids]') || node.querySelector('[data-chatgpt-search-message-ids]');
    const encoded = owner?.getAttribute('data-chatgpt-search-message-ids');
    let messageIds = [];
    if (encoded) {
      try { const parsed = JSON.parse(encoded); messageIds = Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : typeof parsed === 'string' ? [parsed] : []; } catch { messageIds = encoded.split(/[\s,]+/).filter(Boolean); }
    }
    const distinct = [...new Set(messageIds)];
    const turn = node.closest(turnSelector);
    return node.getAttribute('data-message-id') || (distinct.length === 1 ? distinct[0] : null) ||
      (turn?.getAttribute('data-turn-key') ? turn.getAttribute('data-turn-key') + ':' + role : null) ||
      turn?.getAttribute('data-turn-id') || turn?.getAttribute('data-testid') || node.id || ids.get(node);
  }
  function discover(document) {
    const styles = new WeakMap();
    const excluded = node => {
      if (node.closest('nav,aside,form,[contenteditable="true"],[role="textbox"],[hidden],[inert],[aria-hidden="true"],[data-app-action-timeline-scroll][role="presentation"],[data-markdown-text-tone="tertiary"]')) return true;
      for (let el = node; el; el = el.parentElement) {
        if (!styles.has(el)) { const css = document.defaultView.getComputedStyle(el); styles.set(el, css.display === 'none' || css.visibility === 'hidden'); }
        if (styles.get(el)) return true;
      }
      return false;
    };
    const timelines = Array.from(document.querySelectorAll('[data-app-action-timeline-scroll][role="region"]')).filter(node => !excluded(node));
    const scopes = timelines.length ? timelines : [document];
    const candidates = [];
    const counts = { legacyMarkers: 0, searchUnits: 0, turnShells: 0, bodyMarkers: 0, timelines: timelines.length };
    function add(node, role, strategy) {
      if (!['user', 'assistant'].includes(role) || excluded(node)) return;
      if (candidates.some(c => c.role === role && (c.node.contains(node) || node.contains(c.node)))) return;
      candidates.push({ node, role, strategy });
    }
    for (const scope of scopes) {
      const explicit = Array.from(scope.querySelectorAll(roleSelector)); counts.legacyMarkers += explicit.length;
      for (const node of explicit) if (!Array.from(node.querySelectorAll(roleSelector)).some(child => roleOf(child) === roleOf(node) && !excluded(child))) add(node, roleOf(node), 'roles');
      const units = Array.from(scope.querySelectorAll(unitSelector)); counts.searchUnits += units.length;
      for (const node of outermost(units)) {
        const key = node.getAttribute('data-content-search-unit-key') || node.getAttribute('data-chatgpt-search-unit-key');
        add(node, key.endsWith(':user') ? 'user' : 'assistant', 'search-units');
      }
      const turns = Array.from(scope.querySelectorAll(turnSelector)); counts.turnShells += turns.length;
      for (const turn of turns) {
        if (excluded(turn)) continue;
        const bubbles = outermost(Array.from(turn.querySelectorAll(bubbleSelector)));
        for (const node of bubbles) add(node, 'user', 'turn-bodies');
        const bodies = outermost(Array.from(turn.querySelectorAll(assistantSelector))).filter(node => !excluded(node));
        // An exchange may contain several thinking/answer renditions; the last
        // primary answer is the current visible reply, never the tertiary recap.
        if (bodies.length) add(bodies.at(-1), 'assistant', 'turn-bodies');
        if (!candidates.some(c => turn.contains(c.node))) {
          const label = Array.from(turn.querySelectorAll('h5.sr-only,h6.sr-only,[data-message-author]'), el => el.textContent).join(' ');
          if (/ChatGPT\s*(?:said|说|說)|assistant/i.test(label)) add(turn, 'assistant', 'turn-labels');
          else if (/you\s*said|你说|你說|您说|您說/i.test(label)) add(turn, 'user', 'turn-labels');
        }
      }
      // Last fallback stays inside the conversation surface and uses semantic
      // content markers. Never read main.innerText or guess alternating roles.
      const surface = scope === document ? document.querySelector('main') : scope;
      if (surface) {
        const bubbles = outermost(Array.from(surface.querySelectorAll(bubbleSelector)));
        for (const node of bubbles) add(node, 'user', 'body-markers');
        const bodies = outermost(Array.from(surface.querySelectorAll(assistantSelector + ',.markdown,.prose'))); counts.bodyMarkers += bodies.length;
        for (const node of bodies) if (!node.closest(bubbleSelector) && !node.closest('[data-message-author-role="user"],[data-message-role="user"],[data-turn="user"]')) add(node, 'assistant', 'body-markers');
      }
    }
    candidates.sort((a, b) => a.node === b.node ? 0 : a.node.compareDocumentPosition(b.node) & 4 ? -1 : 1);
    return { candidates, counts, excluded };
  }
  function readMessage({ node, role }, excluded, visualNodes = []) {
    let roots = allWithSelf(node, role === 'user' ? bubbleSelector : assistantSelector).filter(el => !excluded(el));
    if (!roots.length) roots = allWithSelf(node, '.markdown,[data-message-content],.whitespace-pre-wrap').filter(el => !excluded(el));
    // Some ChatGPT layouts put Markdown containers INSIDE a diagram's panels.
    // Include the visual frame before reducing roots, otherwise those inner
    // containers bypass the frame marker and flatten the diagram back to text.
    const visuals = visualNodes.filter(visual => visual === node || node.contains(visual));
    roots = outermost([...roots, ...visuals]).sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1);
    const text = trim((roots.length ? roots : [node]).map(serialize).join('\n\n'));
    return { id: messageId(node, role), role, text: text || (node.querySelector('img,canvas,video,[data-testid*="attachment"]') ? '[附件内容，请在原对话查看]' : '') };
  }
  function capture(document, url, context) {
    if (!allowed(url)) throw new Error('请在 ChatGPT 对话页使用折页。');
    const raw = embedded(document, url);
    const { candidates, counts, excluded } = context?.discovered || discover(document);
    activeVisuals = context?.map || new WeakMap();
    const dom = candidates.map(candidate => {
      const message = readMessage(candidate, excluded, context?.nodes);
      const ids = [...new Set(Array.from(message.text.matchAll(/fold-visual:([\w-]+)/g), match => match[1]))];
      const visuals = ids.map(id => context?.assets.get(id)).filter(Boolean);
      return visuals.length ? { ...message, visuals } : message;
    });
    let messages = dom;
    if (raw?.messages.length) {
      const byId = new Map(dom.map(m => [m.id, m]));
      const aligned = dom.length >= raw.messages.length && raw.messages.every((m, i) => m.role === dom[i].role);
      const normalize = text => text.replace(/[^\p{L}\p{N}]/gu, '');
      messages = raw.messages.map((m, i) => {
        const live = byId.get(m.id) || (aligned ? dom[i] : null);
        if (live?.visuals?.length) return { ...m, text: live.text, visuals: live.visuals };
        // Retain source Markdown when the visible words agree. DOM takes over for
        // every streamed change, even a short first token or a shorter edited answer.
        if (live && live.text && !m.text.startsWith('[附件内容') && normalize(live.text) !== normalize(m.text)) return { ...m, text: live.text };
        return m;
      });
      const known = new Set(raw.messages.map(m => m.id));
      if (aligned) messages.push(...dom.slice(raw.messages.length));
      else messages.push(...dom.filter(m => !known.has(m.id) && !raw.messages.some(r => r.role === m.role && normalize(r.text) === normalize(m.text))));
    }
    const unique = new Map();
    for (const m of messages) unique.set(m.id, m);
    return {
      key: keyFor(url), url: new URL(url).origin + new URL(url).pathname,
      title: (raw?.title || document.title.replace(/\s*[-|·]\s*ChatGPT\s*$/i, '') || '当前对话').slice(0, 200),
      messages: [...unique.values()], capturedAt: Date.now(),
      scope: raw ? 'loaded-conversation' : 'visible-page',
      diagnostics: { version: VERSION, ...counts, strategy: [...new Set(candidates.map(c => c.strategy))].join('+') || (raw ? 'embedded' : 'none'), recognized: unique.size, visuals: [...unique.values()].reduce((sum, message) => sum + (message.visuals?.length || 0), 0), readyState: document.readyState }
    };
  }
  async function captureRich(document, url) {
    if (!globalThis.FoldVisualCapture) return capture(document, url);
    const discovered = discover(document), map = new WeakMap(), assets = new Map(), nodes = [];
    let bytes = 0;
    for (const { node } of discovered.candidates) {
      const messageAssets = new Set();
      for (const visual of FoldVisualCapture.detect(node).slice(0, 24)) {
        let asset = await FoldVisualCapture.capture(visual);
        if (!messageAssets.has(asset.id)) {
          if (asset.data && bytes + asset.data.length > 2_500_000) asset = { ...asset, id: asset.id + '-limited', kind: 'unavailable', data: undefined, reason: '当前对话图示较多，已保留文字，请在原对话查看此图。' };
          bytes += asset.data?.length || 0; messageAssets.add(asset.id);
        }
        if (!assets.has(asset.id)) assets.set(asset.id, asset);
        map.set(visual, assets.get(asset.id));
        nodes.push(visual);
      }
    }
    return capture(document, url, { discovered, map, assets, nodes });
  }
  globalThis.FoldCapture = { version: VERSION, capture, captureRich, serialize, allowed, keyFor };
})();
