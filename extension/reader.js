import { segmentMarkdown, plainText, comparisonModel } from './reader-core.js';
const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let session = {}, snapshot = null, answers = [], selected = null, result = { cards: [], sections: [] }, views = new Map();
let preferences = { size: 'balanced', font: 17, follow: false }, toastTimer, saveTimer, currentText = null;
let view = { index: 0, scroll: 0, read: new Set() };
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
  preferences = { size: $('size').value, font: preferences.font, follow: $('follow').checked };
  chrome.storage.local.set({ foldPreferences: preferences });
}
function markdown(text) {
  const html = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }), {
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'object', 'embed'],
    FORBID_ATTR: ['style', 'autofocus', 'srcset']
  });
  const template = document.createElement('template'); template.innerHTML = html;
  template.content.querySelectorAll('img').forEach(img => { const label = document.createElement('span'); label.className = 'quiet'; label.textContent = `[图片：${img.alt || '请在原对话查看'}]`; img.replaceWith(label); });
  template.content.querySelectorAll('a').forEach(a => {
    if (!/^(https?:|mailto:)/i.test(a.getAttribute('href') || '')) a.removeAttribute('href');
    a.target = '_blank'; a.rel = 'noopener noreferrer';
  });
  template.content.querySelectorAll('table').forEach(table => { const wrapper = document.createElement('div'); wrapper.className = 'table-wrap'; table.replaceWith(wrapper); wrapper.append(table); });
  const wrapper = document.createElement('div'); wrapper.append(template.content); return wrapper.innerHTML;
}
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
  const filtered = answers.filter(a => (a.question + '\n' + a.text).toLocaleLowerCase().includes(query));
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
  if (answer.text === currentText) return;
  const previous = result.cards[view.index], scroll = $('card-scroll').scrollTop;
  result = segmentMarkdown(answer.text, { size: preferences.size }); currentText = answer.text;
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
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(result.cards[view.index].markdown); toast('已复制这张卡片的 Markdown。'); } catch { toast('复制未成功，请在独立标签中重试。'); } });
$('sync').addEventListener('click', () => command('resume'));
$('pause').addEventListener('click', () => command(session.status === 'paused' ? 'resume' : 'pause'));
$('source').addEventListener('click', () => command('source')); $('expand').addEventListener('click', () => command('expand'));
async function copyDiagnostics() {
  // Counts and layout strategy only: no title, conversation ID, URL path,
  // message text, DOM HTML, cookies or account/session fields.
  const report = { extension: 'fold-reader', version: chrome.runtime.getManifest().version, status: session.status || 'idle', connected: !!session.tabId, messages: snapshot?.messages.length || 0, answers: answers.length, layout: snapshot?.diagnostics || {} };
  try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); toast('已复制诊断信息，不含聊天正文。'); } catch { toast('复制未成功，请在独立标签中重试。'); }
}
$('copy-diagnostics').addEventListener('click', copyDiagnostics); $('empty-diagnostics').addEventListener('click', copyDiagnostics);
$('extension-version').textContent = 'v' + chrome.runtime.getManifest().version;
$('clear').addEventListener('click', async () => { await command('clear'); await chrome.storage.session.remove('foldReading'); });
$('download').addEventListener('click', () => {
  if (!snapshot) return;
  const source = '# ' + snapshot.title + '\n\n来源：' + snapshot.url + '\n\n' + snapshot.messages.map(m => '## ' + (m.role === 'user' ? '用户' : 'AI 回答') + '\n\n' + m.text).join('\n\n---\n\n');
  const url = URL.createObjectURL(new Blob([source], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = snapshot.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 90) + '.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
});
document.addEventListener('keydown', event => {
  if (event.target.closest('input,select,textarea,button,summary') || event.ctrlKey || event.metaKey || event.altKey || !result.cards.length) return;
  if (event.key === 'ArrowRight') { event.preventDefault(); move(view.index + 1); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); move(view.index - 1); }
  if (event.code === 'Space') { event.preventDefault(); mark(); }
});
const [stored, local] = await Promise.all([chrome.storage.session.get(['foldSession', 'foldReading']), chrome.storage.local.get('foldPreferences')]);
preferences = { ...preferences, ...local.foldPreferences };
$('size').value = preferences.size; $('follow').checked = preferences.follow; font(0);
accept(stored.foldSession);
const saved = stored.foldReading;
if (saved && snapshot && saved.key === snapshot.key && Array.isArray(saved.views)) {
  clearTimeout(saveTimer);
  views = new Map(saved.views.map(([id, v]) => [id, { ...v, read: new Set(v.read) }]));
  if (answers.some(a => a.id === saved.selected) && !preferences.follow) { selected = null; choose(saved.selected); }
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.foldSession) accept(changes.foldSession.newValue); });
