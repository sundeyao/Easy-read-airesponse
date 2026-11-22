import { segmentMarkdown, plainText, comparisonModel } from './reader-core.js';
import { visualFormat } from './visual-utils.js';
const $ = id => document.getElementById(id);
const themes = globalThis.FoldThemes;
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let session = {}, snapshot = null, answers = [], selected = null, result = { cards: [], sections: [] }, views = new Map();
let preferences = { size: 'balanced', font: 17, follow: false, theme: themes.loadCached() }, toastTimer, saveTimer, currentText = null, currentVisuals = '', enlargedVisual = null;
let view = { index: 0, scroll: 0, read: new Set() };
const rasterCache = new Map(), pendingRasters = new Map(), visualFailures = new Map();
let visualEpoch = 0;
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3000); }
async function command(type) { try { const response = await chrome.runtime.sendMessage({ type: 'reader:' + type }); if (response?.error) toast(response.error); } catch { toast('扩展已更新，请关闭此阅读页后重新打开。'); } }
function savePosition() {
  if (!selected || !snapshot) return;
  view.scroll = $('card-scroll').scrollTop; views.set(selected, view);
  clearTimeout(saveTimer); saveTimer = setTimeout(() => {
    chrome.storage.session.set({ foldReading: { key: snapshot.key, selected, views: [...views].map(([id, v]) => [id, { ...v, read: [...v.read] }]) } }).catch(() => {});
  }, 250);
}
function settingChanged() {
  preferences = { ...preferences, size: $('size').value, follow: $('follow').checked };
  chrome.storage.local.set({ foldPreferences: preferences });
}
function preview(button, value) {
  const { colors } = themes.palette(value);
  for (const [name, key] of Object.entries({ bg: '--canvas', ink: '--ink', card: '--card', accent: '--accent' })) button.style.setProperty('--preview-' + name, colors[key]);
}
function themeControls() {
  const value = themes.normalize(preferences.theme);
  for (const button of $('theme-presets').querySelectorAll('[data-theme]')) {
    button.setAttribute('aria-pressed', String(button.dataset.theme === value.preset));
    if (button.dataset.theme === 'custom') preview(button, value);
  }
  for (const part of ['background', 'accent']) {
    if ($('theme-' + part).value !== value[part]) $('theme-' + part).value = value[part];
    $('theme-' + part + '-value').textContent = value[part].toUpperCase();
  }
  const label = themes.PRESETS.find(p => p.id === value.preset)?.label || '自定义';
  $('theme-current').textContent = '当前：' + label;
}
function setTheme(value, persist = true) {
  preferences.theme = themes.normalize(value);
  themes.apply(preferences.theme); themeControls();
  if (persist) settingChanged();
}
$('theme-presets').innerHTML = [...themes.PRESETS, { id: 'custom', label: '自定义配色' }].map(p => `<button type="button" class="theme-choice" data-theme="${p.id}" aria-pressed="false"><span class="theme-preview" aria-hidden="true"><i></i><b>Aa</b></span><span>${p.label}</span></button>`).join('');
for (const button of $('theme-presets').querySelectorAll('[data-theme]')) preview(button, button.dataset.theme);
$('theme-button').addEventListener('click', () => { themeControls(); $('theme-dialog').showModal(); });
for (const id of ['theme-close', 'theme-done']) $(id).addEventListener('click', () => $('theme-dialog').close());
$('theme-reset').addEventListener('click', () => setTheme());
$('theme-presets').addEventListener('click', event => {
  const button = event.target.closest('[data-theme]'); if (!button) return;
  setTheme(button.dataset.theme === 'custom' ? { ...preferences.theme, preset: 'custom' } : button.dataset.theme);
});
for (const part of ['background', 'accent']) $('theme-' + part).addEventListener('input', event => setTheme({ ...preferences.theme, preset: 'custom', [part]: event.target.value }));
function codeTitle(language) {
  const titles={python:'Python',py:'Python',java:'Java',javascript:'JavaScript',js:'JavaScript',typescript:'TypeScript',ts:'TypeScript',text:'纯文本',plaintext:'纯文本',txt:'纯文本',html:'HTML',css:'CSS',scss:'SCSS',json:'JSON',xml:'XML',yaml:'YAML',yml:'YAML',sql:'SQL',bash:'Bash',shell:'Shell',sh:'Shell',powershell:'PowerShell',ps1:'PowerShell',cpp:'C++','c++':'C++',c:'C',csharp:'C#','c#':'C#',go:'Go',rust:'Rust',ruby:'Ruby',php:'PHP',markdown:'Markdown',md:'Markdown'};
  return titles[language.toLowerCase()] || language || '纯文本';
}
function decorateCodeBlocks(fragment) {
  for (const pre of fragment.querySelectorAll('pre')) {
    const code=pre.querySelector(':scope > code'); if (!code) continue;
    const language=[...code.classList].map(value=>value.match(/^language-([\w#+.-]{1,32})$/)?.[1]).find(Boolean) || '';
    const title=codeTitle(language),frame=document.createElement('div'),heading=document.createElement('div');
    frame.className='code-block';heading.className='code-heading';
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 20 20');icon.setAttribute('width','18');icon.setAttribute('height','18');icon.setAttribute('aria-hidden','true');icon.setAttribute('focusable','false');
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','m6.5 5.5-4 4.5 4 4.5m7-9 4 4.5-4 4.5m-2-10-3 12');path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.5');path.setAttribute('stroke-linecap','round');path.setAttribute('stroke-linejoin','round');icon.append(path);
    const label=document.createElement('span');label.className='code-title';label.textContent=title;
    const copy=document.createElement('button');copy.type='button';copy.className='code-copy';copy.dataset.copyCode='';copy.textContent='复制代码';copy.setAttribute('aria-label','复制 '+title+' 代码');
    heading.append(icon,label,copy);pre.replaceWith(frame);frame.append(heading,pre);
  }
}
function markdown(text) {
  const source = text.replace(/!\[[^\]]*\]\(fold-visual:([\w-]+)\)/g, (_, id) => `<span data-fold-visual="${id}"></span>`);
  const html = DOMPurify.sanitize(marked.parse(source, { gfm: true, breaks: true }), {
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'object', 'embed'],
    FORBID_ATTR: ['style', 'autofocus', 'srcset']
  });
  const template = document.createElement('template'); template.innerHTML = html;
  const managedImages = new WeakSet();
  template.content.querySelectorAll('[data-fold-visual]').forEach(placeholder => {
    const asset = visualById(placeholder.dataset.foldVisual);
    if (!asset) { placeholder.textContent = '[图示，请在原对话查看]'; return; }
    const figure = document.createElement('figure'); figure.className = 'original-visual';
    if (usableVisual(asset)) {
      const target = document.createElement('button'); target.type = 'button'; target.className = 'visual-target'; target.dataset.visualAction = 'open'; target.dataset.visualId = asset.id; target.setAttribute('aria-label', '放大查看图示');
      const image = document.createElement('img'); image.dataset.visualId = asset.id; image.src = asset.data; image.alt = asset.text.slice(0, 160); image.width = asset.width; image.height = asset.height; managedImages.add(image); target.append(image); figure.append(target);
      const caption = document.createElement('figcaption');
      const label = document.createElement('span'); label.textContent = asset.kind === 'diagram' ? '原样图示' : '图片'; caption.append(label);
      for (const [action, title] of [['open', '放大'], ['copy', '复制图片'], ['download', '下载 PNG']]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = title; button.dataset.visualAction = action; button.dataset.visualId = asset.id; caption.append(button); }
      figure.append(caption);
      const details = document.createElement('details'), summary = document.createElement('summary'), prose = document.createElement('p'); summary.textContent = '图示文字'; prose.textContent = asset.text; details.append(summary, prose); figure.append(details);
    } else {
      const note = document.createElement('p'); note.className = 'visual-unavailable'; note.textContent = asset.reason || '此图暂时无法复制，请在原对话查看。';
      const prose = document.createElement('p'); prose.className = 'visual-text'; prose.textContent = asset.text; figure.append(note, prose);
    }
    placeholder.replaceWith(figure);
  });
  template.content.querySelectorAll('img').forEach(img => { if (managedImages.has(img)) return; const label = document.createElement('span'); label.className = 'quiet'; label.textContent = `[图片：${img.alt || '请在原对话查看'}]`; img.replaceWith(label); });
  template.content.querySelectorAll('a').forEach(a => {
    if (!/^(https?:|mailto:)/i.test(a.getAttribute('href') || '')) a.removeAttribute('href');
    a.target = '_blank'; a.rel = 'noopener noreferrer';
  });
  template.content.querySelectorAll('table').forEach(table => { const wrapper = document.createElement('div'); wrapper.className = 'table-wrap'; table.replaceWith(wrapper); wrapper.append(table); });
  decorateCodeBlocks(template.content);
  const wrapper = document.createElement('div'); wrapper.append(template.content); return wrapper.innerHTML;
}
function visualById(id) { const asset = answers.find(a => a.id === selected)?.visuals?.find(asset => asset.id === id); return asset && rasterCache.has(id) ? { ...asset, data: rasterCache.get(id) } : asset; }
function usableVisual(asset) { return asset && ['diagram', 'image'].includes(asset.kind) && !!visualFormat(asset.data); }
function visualStamp(answer) { return JSON.stringify((answer?.visuals || []).map(v => [v.id, v.kind, v.data?.length, v.width, v.height, v.reason])); }
async function pngVisual(asset) {
  if (!usableVisual(asset)) throw new Error('Image unavailable');
  if (visualFormat(asset.data) === 'png') return asset;
  if (rasterCache.has(asset.id)) return { ...asset, data: rasterCache.get(asset.id) };
  if (pendingRasters.has(asset.id)) return pendingRasters.get(asset.id);
  const epoch = visualEpoch;
  const promise = (async () => {
    const image = new Image(); image.src = asset.data;
    let timeout;
    try { await Promise.race([image.decode(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Image decode timed out')), 4000); })]); } finally { clearTimeout(timeout); }
    const width = asset.width, height = asset.height;
    let scale = Math.min(2, 1800 / width, 3200 / height, Math.sqrt(4_000_000 / (width * height)));
    const canvas = document.createElement('canvas');
    for (let attempt = 0; attempt < 4; attempt++) {
      canvas.width = Math.max(1, Math.ceil(width * scale)); canvas.height = Math.max(1, Math.ceil(height * scale)); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/png');
      if (data.length <= 1_200_000) { if (epoch === visualEpoch) { rasterCache.set(asset.id, data); visualFailures.delete(asset.id); } return { ...asset, data }; }
      scale *= 0.7;
    }
    throw new Error('Image too large');
  })().catch(error => { if (epoch === visualEpoch) visualFailures.set(asset.id, 'png-conversion'); throw error; }).finally(() => pendingRasters.delete(asset.id));
  pendingRasters.set(asset.id, promise); return promise;
}
async function prepareVisuals(visuals = []) { return Promise.all(visuals.map(async asset => { try { return await pngVisual(asset); } catch { return { ...asset, kind: 'unavailable', data: undefined, reason: '图示转换失败，已保留文字，请在原对话查看。' }; } })); }
function portableMarkdown(text, visuals = []) {
  return text.replace(/!\[[^\]]*\]\(fold-visual:([\w-]+)\)/g, (_, id) => {
    const asset = visuals.find(v => v.id === id); if (!asset) return '[图示，请在原对话查看]';
    return usableVisual(asset) && visualFormat(asset.data) === 'png' ? `![${asset.kind === 'diagram' ? '原样图示' : '图片'}](${asset.data})` : '> ' + (asset.reason || '图示未复制') + '\n\n' + asset.text;
  });
}
async function downloadVisual(asset) {
  if (!usableVisual(asset)) return;
  try { const image = await pngVisual(asset); const link = document.createElement('a'); link.href = image.data; link.download = '折页-' + asset.id + '.png'; link.click(); } catch { toast('此图转换失败，可以查看图示文字或原对话。'); }
}
async function copyVisual(asset) {
  if (!usableVisual(asset)) return;
  try {
    const blob = pngVisual(asset).then(image => new Blob([Uint8Array.from(atob(image.data.split(',')[1]), value => value.charCodeAt(0))], { type: 'image/png' }));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('已复制图片，可直接粘贴。');
  } catch { toast('浏览器未允许复制图片，可以使用“下载 PNG”。'); }
}
function openVisual(asset) {
  if (!usableVisual(asset)) return;
  enlargedVisual = asset; $('visual-full-image').src = asset.data; $('visual-full-image').alt = asset.text.slice(0, 200);
  $('visual-full-image').parentElement.classList.remove('zoomed'); $('visual-zoom').textContent = '原尺寸'; $('visual-zoom').setAttribute('aria-pressed', 'false');
  $('visual-title').textContent = asset.kind === 'diagram' ? '原样图示' : '图片'; $('visual-dialog').showModal();
  pngVisual(asset).then(image => { if (enlargedVisual?.id === asset.id) { enlargedVisual = image; $('visual-full-image').src = image.data; } }).catch(() => {});
}
$('card-body').addEventListener('load', event => {
  const image = event.target; if (!(image instanceof HTMLImageElement) || !image.dataset.visualId) return;
  const asset = visualById(image.dataset.visualId); if (!asset || visualFormat(asset.data) !== 'svg') return;
  pngVisual(asset).then(png => { if (image.isConnected && image.dataset.visualId === asset.id) image.src = png.data; }).catch(() => {});
}, true);
$('card-body').addEventListener('error', event => {
  const image = event.target; if (!(image instanceof HTMLImageElement) || !image.dataset.visualId) return;
  visualFailures.set(image.dataset.visualId, 'display');
  const target = image.closest('.visual-target'); if (target) { target.textContent = '图示加载失败，可展开图示文字并复制诊断信息。'; target.disabled = true; }
}, true);
$('card-body').addEventListener('click', event => {
  const copyCode=event.target.closest('button[data-copy-code]');
  if (copyCode) {
    const frame=copyCode.closest('.code-block'),code=frame?.querySelector('pre > code');
    if (code) navigator.clipboard.writeText(code.textContent).then(()=>toast('已复制 '+frame.querySelector('.code-title').textContent+' 代码。')).catch(()=>toast('复制未成功，请在独立标签中重试。'));
    return;
  }
  const button = event.target.closest('[data-visual-action]'); if (!button) return;
  const asset = visualById(button.dataset.visualId);
  if (button.dataset.visualAction === 'open') openVisual(asset);
  if (button.dataset.visualAction === 'copy') copyVisual(asset);
  if (button.dataset.visualAction === 'download') downloadVisual(asset);
});
$('visual-close').addEventListener('click', () => $('visual-dialog').close());
$('visual-dialog').addEventListener('close', () => { enlargedVisual = null; $('visual-full-image').removeAttribute('src'); });
$('visual-copy').addEventListener('click', () => copyVisual(enlargedVisual)); $('visual-download').addEventListener('click', () => downloadVisual(enlargedVisual));
function zoomVisual() { const zoomed = $('visual-full-image').parentElement.classList.toggle('zoomed'); $('visual-zoom').textContent = zoomed ? '适应窗口' : '原尺寸'; $('visual-zoom').setAttribute('aria-pressed', String(zoomed)); }
$('visual-zoom').addEventListener('click', zoomVisual); $('visual-full-image').addEventListener('click', zoomVisual);
function content(card) {
  const model = comparisonModel(card.markdown);
  if (!model) {
    const trimmed = card.markdown.replace(/^(?:#{1,6} [^\n]+\n*)+/, '');
    return markdown(trimmed || card.markdown);
  }
  return '<div class="comparison">' + model.sides.map(side => `<section class="comparison-side"><h3>${esc(side.title)}</h3>${side.segments.map(s => s.type === 'sequence' ? `<div class="sequence">${s.values.map(v => `<span>${esc(v)}</span>`).join('')}</div>` : s.type === 'metric' ? `<div class="metric">${esc(s.value)}</div>` : markdown(s.value)).join('')}</section>`).join('') + '</div>' + (model.note ? `<div class="comparison-note">${markdown(model.note)}</div>` : '');
}
function listAnswers() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const filtered = answers.filter(a => (a.question + '\n' + a.text + '\n' + (a.visuals || []).map(v => v.text).join('\n')).toLocaleLowerCase().includes(query));
  $('answer-count').textContent = `${answers.length} 条回答`;
  const oldScroll = $('answer-list').scrollTop, oldLeft = $('answer-list').scrollLeft;
  $('answer-list').innerHTML = filtered.map(answer => `<button class="answer${selected === answer.id ? ' active' : ''}" data-answer="${esc(answer.id)}" ${selected === answer.id ? 'aria-current="true"' : ''}><div class="answer-top"><span>回答 ${String(answer.number).padStart(2, '0')}</span><span>${answer.text ? plainText(answer.text).length + ' 字' : '正在生成'}</span></div><strong>${esc(plainText(answer.question).slice(0, 130) || 'AI 回答')}</strong><p>${esc(plainText(answer.text).slice(0, 100) || '等待回答内容…')}</p></button>`).join('') || '<p class="list-empty">' + (query ? '没有匹配的回答。' : session.status === 'empty' ? '已连接页面，但尚未识别到消息。' : snapshot ? '等待原对话加载 AI 回答。' : '连接后，AI 的每条回答会出现在这里。') + '</p>';
  $('answer-list').scrollTop = oldScroll; $('answer-list').scrollLeft = oldLeft;
}
function renderConnection() {
  const labels = { idle: '尚未连接', connecting: '正在连接', live: '实时同步', empty: '未识别消息', paused: '已暂停', closed: '原页已关闭', disconnected: '连接已断开', error: '需要重连' };
  $('status').textContent = labels[session.status] || '尚未连接';
  $('status-dot').className = 'dot ' + (session.status === 'live' ? 'live' : session.error ? 'error' : '');
  $('sync-time').textContent = snapshot?.capturedAt ? new Date(snapshot.capturedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  $('pause').textContent = session.status === 'paused' ? '▶ 继续' : 'Ⅱ 暂停';
  $('pause').title = session.status === 'paused' ? '继续同步' : '暂停同步';
  $('pause').disabled = !session.tabId;
  $('source').disabled = !session.tabId;
  $('error').textContent = session.error || ''; $('error').hidden = !session.error;
  $('source-title').textContent = snapshot?.title || '让长回答，一块一块展开。';
  $('source-description').textContent = snapshot ? `${snapshot.messages.length} 条消息 · 仅当前已加载对话` : '打开 ChatGPT 对话，点击工具栏里的折页图标。';
  $('live-label').textContent = session.status === 'live' ? '随原对话更新' : '当前快照';
  $('download').disabled = !snapshot?.messages.length;
  const connectedEmpty = !!snapshot && !answers.length;
  $('empty-title').textContent = connectedEmpty ? (session.status === 'empty' ? '已连接，但尚未识别到消息' : '等待 AI 回答') : '把对话折成清晰的卡片';
  $('empty-description').textContent = connectedEmpty ? (session.status === 'empty' ? '如果原页面已有回答，请刷新原对话页，再点击折页图标。仍为空时可复制诊断信息。' : '原对话中已加载的 AI 回答会自动出现在这里。') : '在 ChatGPT 对话页面点击折页扩展图标，这里就会开始实时同步。';
  $('empty-steps').hidden = connectedEmpty;
  $('empty-diagnostics').hidden = !connectedEmpty;
}
function renderCard({ preserveScroll = false, preserveFlow = false } = {}) {
  const card = result.cards[view.index];
  $('reading').hidden = !card; $('empty').hidden = !!card;
  if (!card) return;
  const scroll = preserveScroll ? $('card-scroll').scrollTop : view.scroll;
  const flowLeft = $('flow').scrollLeft;
  $('section-count').textContent = `${result.sections.length} 个章节`;
  $('flow').innerHTML = result.sections.map((section, i) => `<button class="${card.sectionId === section.id ? 'active' : ''}" data-section="${esc(section.id)}" ${card.sectionId === section.id ? 'aria-current="step"' : ''}><b>${String(i + 1).padStart(2, '0')}</b><strong>${esc(section.title)}</strong></button>`).join('');
  if (preserveFlow) $('flow').scrollLeft = flowLeft;
  const section = result.sections.find(s => s.id === card.sectionId);
  $('part-bar').hidden = card.parts <= 1;
  $('part-label').textContent = `本章 ${card.part} / ${card.parts}`;
  $('parts').innerHTML = section.cardIds.map((index, i) => `<button data-part="${index}" class="${index === view.index ? 'active' : ''}" aria-label="本章第 ${i + 1} 块">${i + 1}</button>`).join('');
  $('step').textContent = `STEP ${String(view.index + 1).padStart(2, '0')} / ${String(result.cards.length).padStart(2, '0')}`;
  $('card-title').textContent = card.title;
  $('card-body').innerHTML = content(card);
  $('word-count').textContent = `${card.words} 字 · ${card.words < 300 ? '不到 1' : '约 ' + Math.ceil(card.words / 350)} 分钟`;
  $('prev').disabled = view.index === 0;
  $('next').textContent = view.index === result.cards.length - 1 ? '读完了 ✓' : '下一块 →';
  updateProgress();
  $('card-scroll').scrollTop = scroll;
  if (!preserveFlow) $('flow').querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function updateProgress() {
  const card = result.cards[view.index];
  const read = card && view.read.has(card.markdown);
  $('mark').textContent = read ? '✓ 已读' : '○ 标记已读'; $('mark').setAttribute('aria-pressed', String(!!read));
  $('progress').textContent = `${view.index + 1} / ${result.cards.length}`;
}
function choose(id) {
  savePosition(); selected = id;
  view = views.get(id) || { index: 0, scroll: 0, read: new Set() };
  currentText = answers.find(a => a.id === id)?.text || '';
  currentVisuals = visualStamp(answers.find(a => a.id === id));
  result = segmentMarkdown(currentText, { size: preferences.size });
  view.index = Math.min(view.index, Math.max(0, result.cards.length - 1));
  views.set(id, view); listAnswers(); renderCard(); savePosition();
}
function move(index) { savePosition(); view.index = Math.max(0, Math.min(result.cards.length - 1, index)); view.scroll = 0; renderCard(); savePosition(); }
function mark() {
  const card = result.cards[view.index]; if (!card) return;
  if (view.read.has(card.markdown)) view.read.delete(card.markdown); else view.read.add(card.markdown);
  updateProgress(); savePosition();
}
function accept(next) {
  session = next || { status: 'idle' };
  const oldSnapshot = snapshot, nextSnapshot = session.snapshot || null;
  const changedChat = oldSnapshot?.key !== nextSnapshot?.key;
  if (changedChat) {
    visualEpoch++; rasterCache.clear(); pendingRasters.clear(); visualFailures.clear();
    if ($('visual-dialog').open) $('visual-dialog').close();
    clearTimeout(saveTimer); views = new Map(); selected = null; currentText = null;
    view = { index: 0, scroll: 0, read: new Set() };
  }
  snapshot = nextSnapshot;
  let question = '';
  answers = [];
  for (const message of snapshot?.messages || []) {
    if (message.role === 'user') question = message.text;
    if (message.role === 'assistant') answers.push({ ...message, question, number: answers.length + 1 });
  }
  renderConnection();
  const latest = answers.at(-1);
  const target = preferences.follow || !answers.some(a => a.id === selected) ? latest?.id : selected;
  if (target && target !== selected) { choose(target); return; }
  listAnswers();
  if (!target) { result = { cards: [], sections: [] }; renderCard(); return; }
  const answer = answers.find(a => a.id === selected);
  if (answer.text === currentText && visualStamp(answer) === currentVisuals) return;
  const previous = result.cards[view.index], scroll = $('card-scroll').scrollTop;
  result = segmentMarkdown(answer.text, { size: preferences.size }); currentText = answer.text;
  currentVisuals = visualStamp(answer);
  // Streaming additions keep the current section/part and scroll position.
  const same = result.cards.findIndex(c => c.markdown === previous?.markdown);
  const equivalent = result.cards.findIndex(c => c.sectionTitle === previous?.sectionTitle && c.part === previous?.part);
  view.index = same >= 0 ? same : equivalent >= 0 ? equivalent : Math.min(view.index, Math.max(0, result.cards.length - 1));
  view.read = new Set([...view.read].filter(text => result.cards.some(c => c.markdown === text)));
  view.scroll = scroll; renderCard({ preserveScroll: true, preserveFlow: true }); savePosition();
}
$('answer-list').addEventListener('click', event => { const target = event.target.closest('[data-answer]'); if (target) { if (preferences.follow) { $('follow').checked = false; settingChanged(); } choose(target.dataset.answer); } });
$('search').addEventListener('input', listAnswers);
$('flow').addEventListener('click', event => { const target = event.target.closest('[data-section]'); if (target) move(result.sections.find(s => s.id === target.dataset.section).cardIds[0]); });
$('parts').addEventListener('click', event => { const target = event.target.closest('[data-part]'); if (target) move(Number(target.dataset.part)); });
$('prev').addEventListener('click', () => move(view.index - 1));
$('next').addEventListener('click', () => { const card = result.cards[view.index]; if (!card) return; view.read.add(card.markdown); if (view.index < result.cards.length - 1) move(view.index + 1); else { updateProgress(); savePosition(); toast('这一条回答读完了。'); } });
$('mark').addEventListener('click', mark);
$('card-scroll').addEventListener('scroll', savePosition, { passive: true });
$('follow').addEventListener('change', () => { settingChanged(); if (preferences.follow && answers.length) choose(answers.at(-1).id); });
$('size').addEventListener('change', () => { settingChanged(); if (selected) { view.index = 0; view.scroll = 0; view.read.clear(); currentText = null; result = segmentMarkdown(answers.find(a => a.id === selected).text, { size: preferences.size }); renderCard(); savePosition(); } });
function font(delta) { preferences.font = Math.max(13, Math.min(25, preferences.font + delta)); document.documentElement.style.setProperty('--font', preferences.font + 'px'); $('font-value').textContent = preferences.font; settingChanged(); }
$('font-up').addEventListener('click', () => font(1)); $('font-down').addEventListener('click', () => font(-1));
$('copy').addEventListener('click', async () => { try { const answer = answers.find(a => a.id === selected); await navigator.clipboard.writeText(portableMarkdown(result.cards[view.index].markdown, await prepareVisuals(answer?.visuals))); toast('已复制这张卡片的 Markdown。'); } catch { toast('复制未成功，请在独立标签中重试。'); } });
$('sync').addEventListener('click', () => command('resume'));
$('pause').addEventListener('click', () => command(session.status === 'paused' ? 'resume' : 'pause'));
$('source').addEventListener('click', () => command('source')); $('expand').addEventListener('click', () => command('expand'));
async function copyDiagnostics() {
  // Counts and layout strategy only: no title, conversation ID, URL path,
  // message text, DOM HTML, cookies or account/session fields.
  const current = answers.find(a => a.id === selected)?.visuals || [];
  const report = { extension: 'fold-reader', version: chrome.runtime.getManifest().version, status: session.status || 'idle', connected: !!session.tabId, messages: snapshot?.messages.length || 0, answers: answers.length, layout: snapshot?.diagnostics || {}, images: { inCurrentAnswer: current.length, available: current.filter(usableVisual).length, unavailable: current.filter(v => !usableVisual(v)).length, displayedOnCard: [...$('card-body').querySelectorAll('.original-visual img')].filter(img => img.complete && img.naturalWidth > 0).length, pngReady: current.filter(v => visualFormat(v.data) === 'png' || rasterCache.has(v.id)).length, failures: [...new Set(visualFailures.values())] } };
  try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); toast('已复制诊断信息，不含聊天正文。'); } catch { toast('复制未成功，请在独立标签中重试。'); }
}
$('copy-diagnostics').addEventListener('click', copyDiagnostics); $('empty-diagnostics').addEventListener('click', copyDiagnostics);
$('extension-version').textContent = 'v' + chrome.runtime.getManifest().version;
$('clear').addEventListener('click', async () => { await command('clear'); await chrome.storage.session.remove('foldReading'); });
$('download').addEventListener('click', async () => {
  if (!snapshot) return;
  const exporting = snapshot;
  const messages = await Promise.all(exporting.messages.map(async m => '## ' + (m.role === 'user' ? '用户' : 'AI 回答') + '\n\n' + portableMarkdown(m.text, await prepareVisuals(m.visuals))));
  const source = '# ' + exporting.title + '\n\n来源：' + exporting.url + '\n\n' + messages.join('\n\n---\n\n');
  const url = URL.createObjectURL(new Blob([source], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = exporting.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 90) + '.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
});
document.addEventListener('keydown', event => {
  if ($('theme-dialog').open || $('visual-dialog').open || event.target.closest('input,select,textarea,button,summary') || event.ctrlKey || event.metaKey || event.altKey || !result.cards.length) return;
  if (event.key === 'ArrowRight') { event.preventDefault(); move(view.index + 1); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); move(view.index - 1); }
  if (event.code === 'Space') { event.preventDefault(); mark(); }
});
const [stored, local] = await Promise.all([chrome.storage.session.get(['foldSession', 'foldReading']), chrome.storage.local.get('foldPreferences')]);
preferences = { ...preferences, ...local.foldPreferences, theme: themes.normalize(local.foldPreferences?.theme) };
setTheme(preferences.theme, false);
$('size').value = preferences.size; $('follow').checked = preferences.follow; font(0);
accept(stored.foldSession);
const saved = stored.foldReading;
if (saved && snapshot && saved.key === snapshot.key && Array.isArray(saved.views)) {
  clearTimeout(saveTimer);
  views = new Map(saved.views.map(([id, v]) => [id, { ...v, read: new Set(v.read) }]));
  if (answers.some(a => a.id === saved.selected) && !preferences.follow) { selected = null; choose(saved.selected); }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.foldSession) accept(changes.foldSession.newValue);
  if (area === 'local' && changes.foldPreferences) {
    const next = themes.normalize(changes.foldPreferences.newValue?.theme);
    if (JSON.stringify(next) !== JSON.stringify(preferences.theme)) setTheme(next, false);
  }
});
