import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
let passed = 0;
const check = (name, value) => { assert.ok(value, name); console.log('PASS ' + name); passed++; };
const original = join(root, 'extension');
const manifest = JSON.parse(await readFile(join(original, 'manifest.json'), 'utf8'));
check('production permissions are limited to explicit tab access, local storage and side panel', JSON.stringify(manifest.permissions) === JSON.stringify(['activeTab', 'scripting', 'storage', 'sidePanel']) && !manifest.host_permissions && !manifest.content_scripts && !manifest.externally_connectable);
const longText = '用户 ID 来自后端数据库，前端通过接口拿到它。收到返回值后，先保存必要的数据，再将 ID 传给后续请求。'.repeat(45);
const initial = `<!doctype html><html><head><meta charset="utf-8"><title>图片与用户 · ChatGPT</title></head><body><nav>SIDEBAR_SECRET</nav><textarea>DRAFT_SECRET</textarea><div hidden data-message-author-role="assistant" data-message-id="hidden">HIDDEN_SECRET</div>
<article><div data-message-author-role="user" data-message-id="q1"><p>前端如何取得用户 ID？</p></div></article>
<article><div data-message-author-role="assistant" data-message-id="a1"><div class="markdown"><h1>用户 ID 与数据库查询</h1><h2>ID 从哪里来</h2><p>${longText}</p><h2>为什么重复查询</h2><p>${longText}</p><h2>批量查询的流程</h2><p>先去重，再批量查询，最后建立映射。</p></div></div></article>
<article><div data-message-author-role="user" data-message-id="q2"><p>给我代码和表格。</p></div></article>
<article><div data-message-author-role="assistant" data-message-id="a2"><div class="markdown"><h2>代码与表格</h2><pre><button>复制代码</button><code class="language-js">const users = await query(ids);\nconsole.log(users);</code></pre><table><thead><tr><th>方式</th><th>次数</th></tr></thead><tbody><tr><td>批量查询</td><td>1 次</td></tr></tbody></table><ul><li>收集 ID</li><li>去重并查询</li></ul><p><strong>加粗</strong>和<em>重点</em>，<code>inline</code></p></div></div></article>
<article><div data-message-author-role="user" data-message-id="q3"><p>如何设置缓存？</p></div></article>
<article><div data-message-author-role="assistant" data-message-id="a3"><div class="markdown"><h2>设置缓存</h2><p>先确定有效期。</p></div></div></article></body></html>`;
const errors = [];
function logErrors(page) { page.on('pageerror', error => errors.push(error.message)); }
async function launch(extension) {
  const profile = await mkdtemp(join(artifacts, 'profile-'));
  return chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1480, height: 950 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
}
async function workerFor(context) { return context.serviceWorkers()[0] || context.waitForEvent('serviceworker'); }
async function openReader(context, worker) { const page = await context.newPage(); logErrors(page); await page.goto(`chrome-extension://${new URL(worker.url()).host}/reader.html?view=tab`); await page.waitForSelector('#status'); return page; }
async function state(worker) { return worker.evaluate(async () => (await chrome.storage.session.get('foldSession')).foldSession); }
async function waitSnapshot(worker, predicate) {
  for (let i = 0; i < 50; i++) { const current = await state(worker); if (predicate(current)) return current; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Snapshot timed out');
}
// Load the exact production package first. A script cannot grant itself activeTab.
let context = await launch(original);
try {
  const worker = await workerFor(context);
  const reader = await openReader(context, worker);
  check('unmodified production MV3 extension and reader load', await reader.locator('#empty').isVisible());
  check('first launch uses the neutral theme', await reader.evaluate(() => document.documentElement.dataset.theme === 'neutral'));
  await reader.evaluate(() => chrome.storage.local.set({ foldPreferences: { size: 'fine', font: 19, follow: true } }));
  await reader.reload(); await reader.waitForFunction(() => document.querySelector('#font-value').textContent === '19');
  check('pre-theme settings migrate without losing reading preferences', await reader.evaluate(async () => { const value = (await chrome.storage.local.get('foldPreferences')).foldPreferences; return value.theme.preset === 'neutral' && value.size === 'fine' && value.font === 19 && value.follow; }));
  const chat = await context.newPage(); await chat.route('**/*', route => route.fulfill({ contentType: 'text/html', body: initial })); await chat.goto('https://chatgpt.com/c/test-permission');
  const denied = await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture-core.js'] }); return false; } catch { return true; }
  });
  check('production extension cannot read an unapproved tab', denied);
} finally { await context.close(); }
// Playwright cannot click browser chrome. This isolated test copy grants only the
// synthetic chatgpt.com fixture origin, then invokes the same attachment function.
// The shipped manifest is never modified; its activeTab rejection was checked above.
const harness = await mkdtemp(join(artifacts, 'test-extension-')); await cp(original, harness, { recursive: true });
await writeFile(join(harness, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['https://chatgpt.com/*'] }, null, 2));
await writeFile(join(harness, 'background.js'), await readFile(join(original, 'background.js'), 'utf8') + '\n// Test harness only, never shipped.\nglobalThis.__foldTestAttach = id => serial(() => attach(id));\n');
context = await launch(harness);
try {
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: initial }));
  const worker = await workerFor(context); worker.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  const reader = await openReader(context, worker);
  const chat = await context.newPage(); logErrors(chat); await chat.goto('https://chatgpt.com/c/fixture');
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.includes('/c/fixture')).id);
  await worker.evaluate(async id => { await globalThis.__foldTestAttach(id); }, tabId);
  const captured = await waitSnapshot(worker, s => s?.status === 'live');
  check('real extension injection captures loaded user and AI messages', captured.snapshot.messages.length === 6 && captured.snapshot.messages.filter(m => m.role === 'assistant').length === 3);
  check('drafts, sidebar, hidden messages and code buttons are excluded', !JSON.stringify(captured).match(/DRAFT_SECRET|SIDEBAR_SECRET|HIDDEN_SECRET|复制代码/));
  const code = captured.snapshot.messages.find(m => m.id === 'a2').text;
  check('DOM conversion preserves code fences, tables, lists and emphasis', code.includes('```js') && code.includes('| 方式 | 次数 |') && code.includes('- 收集 ID') && code.includes('**加粗**'));
  await reader.waitForSelector('.answer.active');
  check('reader opened before connection receives its first live snapshot', await reader.locator('.answer').count() === 3);
  check('first connection selects the latest assistant answer', await reader.locator('.answer.active').getAttribute('data-answer') === 'a3');
  await reader.click('[data-answer="a1"]');
  check('major headings remain one node each; long sections have subcards', await reader.locator('#flow button').count() === 3 && await reader.locator('#parts button').count() > 1);
  await reader.click('#next');
  await reader.locator('#card-scroll').evaluate(el => el.scrollTop = 110);
  const beforeScroll = await reader.locator('#card-scroll').evaluate(el => el.scrollTop);
  const beforeTitle = await reader.locator('#card-title').textContent();
  await reader.screenshot({ path: join(artifacts, 'extension-flow-desktop.png') });
  const flowY = (await reader.locator('.flow-header').boundingBox()).y;
  await chat.evaluate(() => {
    const wrapper = document.createElement('article'); wrapper.innerHTML = '<div data-message-author-role="user" data-message-id="q4"><p>新问题</p></div><div data-message-author-role="assistant" data-message-id="a4"><div class="markdown"><h2>新回答</h2><p>正在生成。</p></div></div>'; document.body.append(wrapper);
  });
  await waitSnapshot(worker, s => s?.snapshot.messages.length === 8);
  await reader.waitForFunction(() => document.querySelectorAll('.answer').length === 4);
  check('new answers do not steal the selected older answer or its scroll', await reader.locator('.answer.active').getAttribute('data-answer') === 'a1' && await reader.locator('#card-title').textContent() === beforeTitle && await reader.locator('#card-scroll').evaluate(el => el.scrollTop) === beforeScroll);
  check('major-heading flow remains fixed while the reading body scrolls', (await reader.locator('.flow-header').boundingBox()).y === flowY);
  await reader.click('[data-answer="a2"]'); await reader.click('[data-answer="a1"]');
  check('switching answers restores each answer’s own card and position', await reader.locator('#card-title').textContent() === beforeTitle);
  await reader.waitForTimeout(400); await reader.reload(); await reader.waitForSelector('.answer.active');
  check('reopening reader restores the session reading position', await reader.locator('.answer.active').getAttribute('data-answer') === 'a1' && await reader.locator('#card-title').textContent() === beforeTitle);
  await reader.check('#follow');
  check('follow latest selects the most recent answer', await reader.locator('.answer.active').getAttribute('data-answer') === 'a4');
  await chat.evaluate(() => document.querySelector('[data-message-id="a4"] .markdown').insertAdjacentHTML('beforeend', '<h2>流式新增章节</h2><p>追加内容已经更新。</p>'));
  await reader.waitForFunction(() => document.querySelectorAll('#flow button').length === 2);
  check('streaming changes update the selected answer and heading flow', (await reader.locator('#flow').textContent()).includes('流式新增章节'));
  await reader.click('#pause'); await waitSnapshot(worker, s => s?.status === 'paused');
  await chat.evaluate(() => document.querySelector('[data-message-id="a4"] .markdown').insertAdjacentHTML('beforeend', '<h2>暂停期间的新内容</h2>'));
  await reader.waitForTimeout(1400);
  check('pause stops captures and keeps the current snapshot', !(await state(worker)).snapshot.messages.at(-1).text.includes('暂停期间'));
  await reader.click('#pause'); await waitSnapshot(worker, s => s?.status === 'live' && s.snapshot.messages.at(-1).text.includes('暂停期间'));
  check('resume reads changes accumulated while paused', true);
  await reader.uncheck('#follow'); await reader.click('[data-answer="a2"]');
  check('code and table render as native readable elements', await reader.locator('#card-body pre code').count() === 1 && await reader.locator('#card-body table').count() === 1);
  const beforeTheme = { title: await reader.locator('#card-title').textContent(), answer: await reader.locator('.answer.active').getAttribute('data-answer') };
  await reader.click('#theme-button');
  check('theme picker is available directly from the lower toolbar', await reader.locator('#theme-dialog').isVisible() && await reader.locator('.theme-choice').count() === 7);
  await reader.click('[data-theme="dark"]');
  await reader.waitForFunction(async () => (await chrome.storage.local.get('foldPreferences')).foldPreferences.theme.preset === 'dark');
  check('dark theme recolors reading cards and code blocks', await reader.evaluate(() => document.documentElement.style.colorScheme === 'dark' && [document.querySelector('.card'), document.querySelector('.markdown pre')].every(el => getComputedStyle(el).backgroundColor.match(/\d+/g).slice(0, 3).map(Number).reduce((a, b) => a + b) < 300)));
  check('theme choices keep readable labels immediately after switching to dark', await reader.evaluate(() => {
    const hex = value => '#' + value.match(/\d+/g).slice(0, 3).map(Number).map(n => n.toString(16).padStart(2, '0')).join('');
    return [...document.querySelectorAll('.theme-choice')].every(el => { const css = getComputedStyle(el); return FoldThemes.contrast(hex(css.color), hex(css.backgroundColor)) >= 4.5; });
  }));
  await reader.click('#theme-done');
  check('changing a theme preserves the current answer and reading card', await reader.locator('#card-title').textContent() === beforeTheme.title && await reader.locator('.answer.active').getAttribute('data-answer') === beforeTheme.answer);
  await reader.screenshot({ path: join(artifacts, 'theme-dark-desktop.png') });
  await reader.reload(); await reader.waitForSelector('.answer.active');
  check('theme selection persists when the reader is reopened', await reader.evaluate(() => document.documentElement.dataset.theme === 'dark'));
  const secondReader = await openReader(context, worker);
  await reader.click('#theme-button');
  for (const [id, value] of [['theme-background', '#272033'], ['theme-accent', '#efb862']]) await reader.locator('#' + id).evaluate((el, color) => { el.value = color; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await secondReader.waitForFunction(() => document.documentElement.dataset.theme === 'custom' && document.documentElement.style.getPropertyValue('--canvas') === '#272033');
  check('custom background and accent update all open readers', await secondReader.evaluate(async () => { const t = (await chrome.storage.local.get('foldPreferences')).foldPreferences.theme; return t.preset === 'custom' && t.background === '#272033' && t.accent === '#efb862'; }));
  await reader.click('#theme-done'); await reader.click('#font-up');
  check('changing font size does not reset the saved custom theme', await reader.evaluate(async () => (await chrome.storage.local.get('foldPreferences')).foldPreferences.theme.background === '#272033'));
  await reader.click('#font-down'); await reader.reload(); await reader.waitForSelector('.answer.active');
  check('custom colors persist across reload with the exact selected values', await reader.evaluate(() => document.documentElement.style.getPropertyValue('--canvas') === '#272033' && document.querySelector('#theme-accent').value === '#efb862'));
  await reader.click('#theme-button');
  for (const preset of ['neutral', 'warm', 'blue', 'purple', 'green', 'dark']) {
    await reader.click(`[data-theme="${preset}"]`);
    check('preset applies immediately: ' + preset, await reader.evaluate(id => document.documentElement.dataset.theme === id, preset));
  }
  await reader.click('[data-theme="blue"]');
  await reader.screenshot({ path: join(artifacts, 'theme-picker-desktop.png') });
  await reader.click('#theme-reset');
  await secondReader.waitForFunction(() => document.documentElement.dataset.theme === 'neutral');
  check('reset restores neutral colors in every reader', await reader.evaluate(async () => (await chrome.storage.local.get('foldPreferences')).foldPreferences.theme.preset === 'neutral'));
  await reader.click('#theme-done'); await secondReader.close();
  await reader.screenshot({ path: join(artifacts, 'extension-desktop.png') });
  for (const width of [1280, 820, 740, 420, 390, 320]) {
    await reader.setViewportSize({ width, height: width < 760 ? 900 : 950 });
    check('reader stays inside viewport at ' + width + 'px', await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight));
  }
  await reader.setViewportSize({ width: 420, height: 900 });
  await reader.screenshot({ path: join(artifacts, 'extension-sidepanel.png') });
  await reader.click('#theme-button');
  for (const width of [420, 320]) {
    await reader.setViewportSize({ width, height: 900 });
    const box = await reader.locator('#theme-dialog').boundingBox();
    check('theme dialog fits the browser side panel at ' + width + 'px', box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 900 && await reader.locator('#theme-background').isVisible());
  }
  await reader.setViewportSize({ width: 420, height: 900 });
  await reader.click('[data-theme="dark"]'); await reader.screenshot({ path: join(artifacts, 'theme-picker-sidepanel.png') });
  await reader.click('#theme-reset'); await reader.click('#theme-close');
  await reader.click('.settings summary');
  check('narrow side panel keeps export and reading settings accessible', await reader.locator('#download').isVisible());
  await reader.click('.settings summary');
  await reader.setViewportSize({ width: 1480, height: 950 });
  await chat.evaluate(() => {
    history.pushState({}, '', '/c/second'); document.title = '第二个对话 · ChatGPT';
    document.body.innerHTML = '<div data-message-role="user" data-message-id="bq"><p>第二个问题</p></div><div data-message-role="assistant" data-message-id="ba"><div class="markdown"><h2>第二个对话的回答</h2><p>独立内容</p></div></div>';
  });
  await waitSnapshot(worker, s => s?.snapshot.key.endsWith('/c/second') && s.snapshot.messages.length === 2);
  await reader.waitForFunction(() => document.querySelectorAll('.answer').length === 1 && document.querySelector('.answer.active')?.dataset.answer === 'ba');
  check('SPA route change replaces the conversation without mixing old messages', await reader.locator('#card-title').textContent() === '第二个对话的回答');
  await chat.reload(); await waitSnapshot(worker, s => s?.snapshot.messages.length === 6);
  check('same-origin full reload reconnects the watched tab', true);
  // Check the current JSON format on an inert synthetic shared page, including a token trap.
  await chat.evaluate(() => {
    history.pushState({}, '', '/share/fixture'); document.body.innerHTML = '';
    const node = document.createElement('script'); node.type = 'application/json'; node.id = '__WEB_MOBILE_DATA__';
    node.textContent = JSON.stringify({ canonicalPath: '/share/fixture', session: { accessToken: 'TOKEN_SECRET' }, conversation: { title: '共享测试', messages: [{ id: 's1', role: 'user', content: '', maskedUploads: [{}] }, { id: 's2', role: 'assistant', content: '## 共享内容\n\n**原始 Markdown**' }] } }); document.body.append(node);
  });
  const shared = await waitSnapshot(worker, s => s?.snapshot.key.endsWith('/share/fixture') && s.snapshot.messages.length === 2);
  check('shared-page extraction retains Markdown and attachment-only questions', shared.snapshot.messages[1].text.includes('**原始 Markdown**') && shared.snapshot.messages[0].text.includes('附件'));
  check('JSON extraction never copies session/token fields', !JSON.stringify(shared).includes('TOKEN_SECRET'));
  await chat.evaluate(() => {
    const q = document.createElement('div'); q.setAttribute('data-message-role', 'user'); q.setAttribute('data-message-id', 's1');
    q.innerHTML = '<img alt="附件">';
    const a = document.createElement('div'); a.setAttribute('data-message-role', 'assistant'); a.setAttribute('data-message-id', 's2'); a.innerHTML = '<div class="markdown"><p>好</p></div>';
    document.body.append(q, a);
  });
  const firstToken = await waitSnapshot(worker, s => s?.snapshot.messages[1]?.text === '好');
  check('even a one-character streaming change replaces stale embedded content', firstToken.snapshot.messages[0].text.includes('附件'));
  await chat.evaluate(() => {
    const extra = document.createElement('div'); extra.innerHTML = '<div data-message-role="user" data-message-id="s3"><p>再问</p></div><div data-message-role="assistant" data-message-id="s4"><p>新答</p></div>'; document.body.append(extra);
  });
  await waitSnapshot(worker, s => s?.snapshot.messages.length === 4);
  check('DOM messages added after embedded data do not duplicate existing messages', true);
  await chat.evaluate(() => {
    document.getElementById('__WEB_MOBILE_DATA__').remove();
    document.body.innerHTML = '<div data-message-role="assistant" data-message-id="xss"><div class="markdown"><p>&lt;img src=x onerror=alert(1)&gt;</p><a href="javascript:alert(1)">危险链接</a><img src="https://example.invalid/tracker" alt="测试图片"></div></div>';
  });
  await reader.waitForFunction(() => document.querySelector('.answer.active')?.dataset.answer === 'xss');
  check('rendered content cannot execute HTML or load remote images', await reader.locator('#card-body img, #card-body script, #card-body [onerror], #card-body a[href^="javascript:"]').count() === 0);
  const modernFixture = await readFile(join(root, 'tests/fixtures/chat-work.html'), 'utf8');
  await chat.evaluate(html => {
    history.pushState({}, '', '/c/modern-layout');
    const parsed = new DOMParser().parseFromString(html, 'text/html'); document.title = parsed.title; document.body.replaceWith(parsed.body);
  }, modernFixture);
  const modern = await waitSnapshot(worker, s => s?.snapshot.key.endsWith('/c/modern-layout') && s.snapshot.messages.length === 4);
  check('new Chat/Work layout captures both roles with no legacy markers', modern.snapshot.diagnostics.legacyMarkers === 0 && modern.snapshot.messages.filter(m => m.role === 'assistant').length === 2 && modern.snapshot.diagnostics.strategy.includes('search-units'));
  check('nested search-unit wrappers and repeated message IDs are deduplicated', modern.snapshot.messages.map(m => m.id).join(',') === 'modern-question-1,modern-answer-1,modern-question-2,modern-answer-2');
  check('new layout excludes hidden timeline, draft, sidebar and tertiary thinking recap', !JSON.stringify(modern.snapshot).match(/SIDEBAR_SECRET|DRAFT_SECRET|HIDDEN_TIMELINE_SECRET|THINKING_RECAP_SECRET|显示更多/));
  await reader.waitForFunction(() => document.querySelectorAll('.answer').length === 2);
  await reader.click('[data-answer="modern-answer-1"]');
  check('new-layout answer cards retain the matching question and chapter flow', (await reader.locator('.answer.active').textContent()).includes('getById 和 listByIds') && (await reader.locator('#flow').textContent()).includes('分页数据的批量转换'));
  await reader.screenshot({ path: join(artifacts, 'extension-modern-layout.png') });
  await chat.evaluate(() => {
    const body = document.querySelector('[data-chatgpt-search-message-ids=\'["modern-answer-2"]\'] [data-markdown-text-style]');
    const paragraph = document.createElement('p'); paragraph.textContent = '后续请求继续使用该 ID。'; body.append(paragraph);
  });
  await waitSnapshot(worker, s => s?.snapshot.messages.at(-1).text.includes('后续请求继续使用该 ID'));
  check('new-layout streaming still refreshes the current answer', true);
  await chat.evaluate(() => {
    const turn = document.querySelector('[data-turn-key="modern-question-1"]');
    const replacement = turn.cloneNode(true); replacement.querySelectorAll('[data-content-search-unit-key],[data-chatgpt-search-unit-key]').forEach(node => {
      for (const name of ['data-content-search-unit-key', 'data-chatgpt-search-unit-key']) if (node.hasAttribute(name)) node.setAttribute(name, node.getAttribute(name).replace('fallback-turn-0', 'fallback-turn-8'));
    }); turn.replaceWith(replacement);
  });
  await reader.waitForTimeout(850);
  check('remounting a modern turn keeps message identity and selected answer stable', await reader.locator('.answer.active').getAttribute('data-answer') === 'modern-answer-1');
  await chat.evaluate(() => { document.body.innerHTML = '<main><div data-app-action-timeline-scroll role="region"><p>没有可识别标记的正文</p></div></main>'; });
  await waitSnapshot(worker, s => s?.status === 'empty');
  await reader.waitForFunction(() => document.querySelector('#status').textContent === '未识别消息');
  check('zero-message capture reports an empty layout instead of a green live status', await reader.locator('#status-dot.live').count() === 0 && (await reader.locator('#empty-title').textContent()).includes('尚未识别'));
  await reader.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { globalThis.__foldDiagnostic = value; } } }));
  await reader.click('#empty-diagnostics');
  const diagnostics = await reader.evaluate(() => JSON.parse(globalThis.__foldDiagnostic));
  check('copy diagnostics contains layout counts and version without conversation content or identity', diagnostics.version === manifest.version && diagnostics.layout.recognized === 0 && !JSON.stringify(diagnostics).match(/modern-layout|没有可识别|chatgpt.com|新版登录对话|messages":\[/));
  await chat.evaluate(() => { document.querySelector('main').innerHTML = '<section data-turn="user" data-turn-id="section-q"><p>旧版段落问题</p></section><section data-turn="assistant" data-turn-id="section-a"><div class="markdown"><h2>段落布局的回答</h2><p>恢复识别。</p></div></section>'; });
  await waitSnapshot(worker, s => s?.status === 'live' && s.snapshot.messages.length === 2);
  check('empty capture keeps watching and recovers automatically when content mounts', true);
  check('section-based legacy turn shells are also supported', (await state(worker)).snapshot.messages[1].id === 'section-a');
  const other = await context.newPage(); await other.goto('https://chatgpt.com/c/another-source');
  const otherId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.includes('/c/another-source')).id);
  await worker.evaluate(async id => { await globalThis.__foldTestAttach(id); }, otherId);
  await waitSnapshot(worker, s => s?.snapshot.key.endsWith('/c/another-source'));
  check('capture helpers are isolated from the web page’s JavaScript', await chat.evaluate(() => typeof globalThis.FoldCapture === 'undefined'));
  await chat.evaluate(() => { const node = document.createElement('div'); node.setAttribute('data-message-role', 'assistant'); node.setAttribute('data-message-id', 'old-tab-late'); node.textContent = '旧标签的新内容'; document.body.append(node); });
  await reader.waitForTimeout(900);
  check('switching the connected source prevents updates from the previous tab', (await state(worker)).snapshot.key.endsWith('/c/another-source') && !(await state(worker)).snapshot.messages.some(m => m.id === 'old-tab-late'));
  await other.close(); await waitSnapshot(worker, s => s?.status === 'closed');
  check('closing the source preserves the last snapshot and reports its status', !!(await state(worker)).snapshot && (await state(worker)).tabId === null);
  await reader.click('.settings summary');
  await reader.click('#clear'); await waitSnapshot(worker, s => s?.status === 'idle' && !s.snapshot);
  check('clearing stops sync and removes the session snapshot', await reader.locator('#empty').isVisible());
  if (errors.length) console.log('RUNTIME ERRORS', errors);
  check('extension reader has no runtime errors', errors.length === 0);
  console.log(`\n${passed} checks passed. Real production package permission check + isolated synthetic-origin integration harness.`);
} finally { await context.close(); }
