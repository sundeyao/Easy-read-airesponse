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
  const visualFixture = await readFile(join(root, 'tests/fixtures/visuals.html'), 'utf8');
  const restrictedFixture = await reader.evaluate(html => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const frame = parsed.querySelector('.flow-picture'), children = [...frame.children], first = parsed.createElement('div'), second = parsed.createElement('div');
    first.className = second.className = 'flow-fragment'; first.style.display = second.style.display = 'flex'; first.style.flexDirection = second.style.flexDirection = 'column';
    first.append(...children.slice(0, 3)); second.append(...children.slice(4)); frame.replaceChildren(first, children[3], second);
    const content = parsed.querySelector('[data-markdown-text-style]'); content.removeAttribute('data-markdown-text-style');
    for (const node of content.querySelectorAll('p,h2,.flow-panel strong,.flow-panel small,.connector')) node.setAttribute('data-markdown-text-style', 'assistant-message');
    parsed.querySelector('.source-image').src = 'https://chatgpt.com/fixture-image.png';
    return '<!doctype html>' + parsed.documentElement.outerHTML;
  }, visualFixture);
  const sampleImage = await reader.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 140; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e7edf7'; ctx.fillRect(0, 0, 320, 140); ctx.fillStyle = '#436d9b'; ctx.beginPath(); ctx.arc(160, 70, 44, 0, Math.PI * 2); ctx.fill(); return canvas.toDataURL(); });
  await context.route('https://chatgpt.com/fixture-image.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(sampleImage.split(',')[1], 'base64') }));
  await context.route('https://chatgpt.com/c/visuals', route => route.fulfill({ contentType: 'text/html;charset=utf-8', headers: { 'content-security-policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: blob:; connect-src 'none'" }, body: restrictedFixture }));
  await chat.goto('https://chatgpt.com/c/visuals');
  const withVisuals = await waitSnapshot(worker, s => s?.snapshot.key.endsWith('/c/visuals') && s.snapshot.messages.find(m => m.id === 'visual-a')?.visuals?.length === 3);
  const visualAnswer = withVisuals.snapshot.messages.find(m => m.id === 'visual-a');
  check('nested flow wrappers and fragmented Markdown roots preserve one complete diagram', visualAnswer.visuals[0].kind === 'diagram' && visualAnswer.visuals[0].text.includes('后端 Controller') && visualAnswer.visuals[0].text.includes('腾讯云 COS') && visualAnswer.visuals.filter(v => v.text.includes('后端 Controller')).length === 1);
  check('source CSP that disallows data images no longer prevents visual capture', visualAnswer.visuals.every(v => ['diagram', 'image'].includes(v.kind) && /^data:image\/(?:png|svg\+xml);base64,/.test(v.data)));
  check('diagram capture excludes drafts and sidebar content', !visualAnswer.visuals.some(v => /DRAFT_SECRET|SIDEBAR_SECRET/.test(v.text)));
  await reader.waitForFunction(() => document.querySelector('.answer.active')?.dataset.answer === 'visual-a');
  await reader.fill('#search', 'HttpServletResponse');
  check('text inside a captured diagram remains searchable', await reader.locator('.answer').count() === 1);
  await reader.fill('#search', '');
  check('a complete flow stays one atomic visual marker instead of flattened headings', (visualAnswer.text.match(/fold-visual:/g) || []).length === 3 && !visualAnswer.text.includes('后端 Controller') && visualAnswer.visuals[0].text.includes('后端 Controller') && visualAnswer.visuals[0].text.includes('↑'));
  await reader.waitForFunction(() => document.querySelector('.answer.active')?.dataset.answer === 'visual-a');
  await reader.locator('#flow button').filter({ hasText: '先看整个数据传递过程' }).click();
  await reader.waitForFunction(() => document.querySelector('.original-visual img')?.complete && document.querySelector('.original-visual img')?.naturalWidth > 0 && document.querySelector('.original-visual img')?.src.startsWith('data:image/png;base64,'));
  check('reader displays the entire flow as an image in its matching chapter', await reader.locator('#card-body .original-visual').count() === 1 && await reader.locator('#card-body .original-visual img').count() === 1);
  const firstImage = visualAnswer.visuals[0];
  const displayedPng = await reader.locator('.original-visual img').getAttribute('src');
  await writeFile(join(artifacts, 'copied-flow.png'), Buffer.from(displayedPng.split(',')[1], 'base64'));
  check('complete diagrams stay in one reading card without a second image page', await reader.locator('#part-bar').isHidden() && await reader.locator('#card-body .original-visual img').count() === 1);
  await chat.locator('.flow-picture').screenshot({ path: join(artifacts, 'source-flow.png') });
  const colors = await reader.evaluate(async () => {
    const img = document.querySelector('.original-visual img'); await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const result = []; for (let y = 0; y < canvas.height; y += 7) for (let x = 0; x < canvas.width; x += 7) { const p = ctx.getImageData(x, y, 1, 1).data; result.push(p[0] + ',' + p[1] + ',' + p[2]); }
    return [...new Set(result)];
  });
  check('flow snapshot retains the original blue, green and amber panel colors', ['17,24,32', '15,32,25', '48,36,17'].every(color => colors.includes(color)));
  await reader.setViewportSize({ width: 1480, height: 1400 }); await reader.locator('#card-scroll').evaluate(el => el.scrollTop = 0);
  await reader.screenshot({ path: join(artifacts, 'visual-reader-desktop.png') });
  await reader.locator('.visual-target').click();
  check('visuals open in a larger reader dialog', await reader.locator('#visual-dialog').isVisible() && await reader.locator('#visual-full-image').getAttribute('src') === displayedPng);
  await reader.click('#visual-zoom'); check('original-size zoom is available', await reader.locator('#visual-zoom').getAttribute('aria-pressed') === 'true');
  await reader.click('#visual-close');
  await reader.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async value => { globalThis.__copiedMarkdown = value; },
    write: async items => { const blob = await items[0].getType('image/png'); globalThis.__copiedImage = { type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer()).slice(0, 8)), size: blob.size }; }
  } }));
  await reader.locator('[data-visual-action="copy"]').click(); await reader.waitForFunction(() => !!globalThis.__copiedImage);
  check('copy image writes a valid PNG clipboard item without touching the system clipboard in tests', await reader.evaluate(() => __copiedImage.type === 'image/png' && __copiedImage.size > 1000 && __copiedImage.bytes.join(',') === '137,80,78,71,13,10,26,10'));
  const pngDownload = reader.waitForEvent('download'); await reader.locator('[data-visual-action="download"]').click();
  const downloadedPng = await pngDownload; await downloadedPng.saveAs(join(artifacts, 'downloaded-flow.png'));
  check('download image produces a PNG file', downloadedPng.suggestedFilename().endsWith('.png') && (await readFile(join(artifacts, 'downloaded-flow.png'))).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  await reader.click('#copy');
  check('copy card embeds its local images in portable Markdown', await reader.evaluate(() => __copiedMarkdown.includes('data:image/png;base64,') && !__copiedMarkdown.includes('fold-visual:')));
  await reader.click('.settings summary'); const mdDownload = reader.waitForEvent('download'); await reader.click('#download');
  const downloadedMd = await mdDownload; await downloadedMd.saveAs(join(artifacts, 'visual-export.md')); await reader.click('.settings summary');
  const exportedMd = await readFile(join(artifacts, 'visual-export.md'), 'utf8');
  check('conversation export retains visual data without unresolved internal markers', exportedMd.includes('data:image/png;base64,') && !exportedMd.includes('fold-visual:'));
  await reader.locator('#flow button').filter({ hasText: '图片与矢量图' }).click();
  check('ordinary images and vector charts remain in document order', await reader.locator('.original-visual img').count() === 2);
  await reader.setViewportSize({ width: 390, height: 900 });
  await reader.locator('#flow button').filter({ hasText: '先看整个数据传递过程' }).click();
  check('large diagrams fit the narrow side panel without page overflow', await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.original-visual img').getBoundingClientRect().width < innerWidth));
  await reader.locator('.visual-target').click();
  const visualBox = await reader.locator('#visual-dialog').boundingBox();
  check('visual enlargement dialog fits a narrow side panel', visualBox.x >= 0 && visualBox.x + visualBox.width <= 390 && visualBox.y >= 0 && visualBox.y + visualBox.height <= 900);
  await reader.click('#visual-close'); await reader.setViewportSize({ width: 1480, height: 950 });
  const oldDiagramId = firstImage.id;
  await chat.evaluate(() => { const title = document.querySelector('.flow-panel strong'); title.textContent = '前端浏览器（已更新）'; });
  await waitSnapshot(worker, s => s?.snapshot.messages.find(m => m.id === 'visual-a')?.visuals?.[0].id !== oldDiagramId);
  check('diagram changes refresh their captured image automatically', true);
  let externalImageRequests = 0;
  const externalPng = await readFile(join(original, 'icon.png'));
  await context.route('https://visual-cdn.example/image.png', route => { externalImageRequests++; return route.fulfill({ contentType: 'image/png', body: externalPng }); });
  await chat.evaluate(() => { const img = document.createElement('img'); img.alt = '跨域受限图片'; img.src = 'https://visual-cdn.example/image.png'; img.style.width = '150px'; img.style.height = '70px'; document.querySelector('[data-markdown-text-style]').append(img); });
  const blockedImage = await waitSnapshot(worker, s => s?.snapshot.messages.find(m => m.id === 'visual-a')?.visuals?.some(v => v.kind === 'unavailable' && v.text.includes('跨域受限图片')));
  check('cross-origin image restrictions produce an explicit fallback instead of breaking text capture', blockedImage.status === 'live');
  await reader.waitForTimeout(800);
  check('the extension does not refetch remote image URLs', externalImageRequests === 1);
  const agentFixture = await readFile(join(root, 'tests/fixtures/agent-flow.html'), 'utf8');
  const framedAgentFixture = await reader.evaluate(html => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const body = parsed.querySelector('[data-markdown-text-style]');
    body.style.cssText = 'border:1px solid #444;border-radius:16px;padding:10px';
    const notes = parsed.createElement('div'); notes.style.cssText = 'border:1px solid #555;border-radius:10px;padding:10px';
    notes.innerHTML = '<div style="background:#e8f2ff;color:#101828;border-radius:8px;padding:14px">普通说明卡片甲，不是流程图。</div><div style="background:#eff5e8;color:#101828;border-radius:8px;padding:14px">普通说明卡片乙，也不是流程图。</div>';
    body.querySelector('pre').before(notes);
    return '<!doctype html>' + parsed.documentElement.outerHTML;
  }, agentFixture);
  await context.route('https://chatgpt.com/c/agent-flow', route => route.fulfill({ contentType:'text/html;charset=utf-8', body:framedAgentFixture }));
  await chat.goto('https://chatgpt.com/c/agent-flow');
  const agentState = await waitSnapshot(worker, s => s?.snapshot.key.endsWith('/c/agent-flow') && s.snapshot.messages.find(m => m.id === 'agent-a')?.visuals?.length === 2);
  const agentAnswer = agentState.snapshot.messages.find(m => m.id === 'agent-a'), agentImage = agentAnswer.visuals[0];
  check('a flow with its own heading, parallel branches and loop is captured as one image', agentImage.kind === 'diagram' && ['AI Agent 的工作流程','① 用户输入任务','不需要工具','需要工具','④ 执行结果返回给 LLM','回到步骤②'].every(text => agentImage.text.includes(text)) && !agentAnswer.text.includes('① 用户输入任务'));
  check('rounded answer containers and ordinary colored notes do not merge separate chapters into a diagram', !agentImage.text.includes('导入依赖') && agentAnswer.text.includes('普通说明卡片甲') && agentAnswer.text.includes('import subprocess') && !agentImage.text.includes('独立矢量'));
  await reader.waitForFunction(() => document.querySelector('.answer.active')?.dataset.answer === 'agent-a');
  await reader.locator('#flow button').filter({hasText:'先理解整个程序'}).click();
  await reader.waitForFunction(() => { const img=document.querySelector('.original-visual img'); return img?.complete && img.naturalWidth > 0 && img.src.startsWith('data:image/png;base64,'); });
  check('the titled agent flow appears on the selected chapter without flattening its own title into navigation', await reader.locator('.original-visual img').count() === 1 && await reader.locator('#part-bar').isHidden() && await reader.locator('#flow button').filter({hasText:'AI Agent 的工作流程'}).count() === 0);
  const sourceFeatures = await chat.evaluate(() => {
    const frame=document.querySelector('.agent-frame').getBoundingClientRect();
    const region=selector => { const r=document.querySelector(selector).getBoundingClientRect(); return {x:r.x-frame.x,y:r.y-frame.y,width:r.width,height:r.height}; };
    return { width:frame.width,height:frame.height, bright:['.agent-frame>h2','.agent-branch:first-child strong','.agent-branch:last-child strong','.agent-loop strong'].map(region), fills:['.agent-step','.agent-step.python','.agent-step.result'].map(region) };
  });
  const renderedFeatures = await reader.evaluate(async features => {
    const img=document.querySelector('.original-visual img'); await img.decode();
    const canvas=document.createElement('canvas'); canvas.width=img.naturalWidth; canvas.height=img.naturalHeight; const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0);
    const sx=canvas.width/features.width, sy=canvas.height/features.height;
    const bright=features.bright.map(r => { let count=0; for(let y=Math.ceil(r.y*sy);y<(r.y+r.height)*sy;y++) for(let x=Math.ceil(r.x*sx);x<(r.x+r.width)*sx;x++) { const p=ctx.getImageData(x,y,1,1).data; if(p[0]>160&&p[1]>160&&p[2]>160) count++; } return count; });
    const fills=features.fills.map(r => [...ctx.getImageData(Math.round((r.x+16)*sx),Math.round((r.y+12)*sy),1,1).data].slice(0,3).join(','));
    return {bright,fills};
  }, sourceFeatures);
  check('the rendered PNG contains the title, both branches on their source row and the bottom loop label', renderedFeatures.bright.every(count => count > 15));
  check('the rendered agent flow retains the source blue, green and cream step colors', renderedFeatures.fills.join('|') === '232,242,255|239,245,232|255,243,227');
  await reader.locator('#card-scroll').evaluate(el => el.scrollTop=0); await reader.setViewportSize({width:1480,height:1350});
  await reader.screenshot({path:join(artifacts,'agent-reader-desktop.png')});
  await chat.locator('.agent-frame').screenshot({path:join(artifacts,'agent-source.png')});
  await writeFile(join(artifacts,'agent-captured.png'),Buffer.from((await reader.locator('.original-visual img').getAttribute('src')).split(',')[1],'base64'));
  await reader.click('.settings summary'); await reader.click('#copy-diagnostics'); await reader.click('.settings summary');
  const agentDiagnostics=await reader.evaluate(() => JSON.parse(__copiedMarkdown));
  check('image diagnostics distinguish a displayed PNG from an unrelated available visual', agentDiagnostics.images.inCurrentAnswer === 2 && agentDiagnostics.images.displayedOnCard === 1 && agentDiagnostics.images.pngReady >= 1 && agentDiagnostics.images.failures.length === 0);
  const oldAgentId=agentImage.id;
  await chat.evaluate(() => { const old=document.querySelector('.agent-frame>h2'); const heading=document.createElement('h3'); heading.textContent=old.textContent; heading.style.cssText='font-size:20px;margin:0 0 14px'; old.replaceWith(heading); });
  await waitSnapshot(worker,s => s?.snapshot.messages.find(m=>m.id==='agent-a')?.visuals?.[0].id !== oldAgentId && s.snapshot.messages.find(m=>m.id==='agent-a')?.visuals?.[0].text.includes('回到步骤②'));
  check('diagram-local H3 titles are preserved as well as H2 titles', true);
  const codeFixture=await readFile(join(root,'tests/fixtures/code-blocks.html'),'utf8');
  await context.route('https://chatgpt.com/c/code-blocks',route=>route.fulfill({contentType:'text/html;charset=utf-8',body:codeFixture}));
  await chat.goto('https://chatgpt.com/c/code-blocks');
  const codeState=await waitSnapshot(worker,s=>s?.snapshot.key.endsWith('/c/code-blocks')&&s.snapshot.messages.some(m=>m.id==='code-a'&&m.text.includes('def run_task')));
  const codeAnswer=codeState.snapshot.messages.find(m=>m.id==='code-a');
  const python='def run_task(task):\n    if task:\n\n\n        # keep trailing spaces  \n        return {"tool_use": task, "message": "<hello> & 你好\u00a0"}\n    return None';
  const javascript='const tools = ["bash"];\nif (tools.length) {\n    console.log("``` <tag>");\n}';
  check('code blocks outside the marked Markdown containers retain indentation, symbols and language fences',codeAnswer.text.includes('```python\n'+python+'\n```')&&codeAnswer.text.includes('````javascript\n'+javascript+'\n````'));
  check('capturing output editors excludes editable drafts, hidden code, thinking blocks and toolbars',!JSON.stringify(codeState.snapshot).match(/DRAFT_SECRET|COMPOSER_SECRET|HIDDEN_SECRET|THINKING_SECRET|UI_SECRET|复制代码/));
  await reader.waitForFunction(()=>document.querySelector('.answer.active')?.dataset.answer==='code-a');
  await reader.locator('#flow button').filter({hasText:'Python 代码'}).click();
  check('the reader actually displays the Python code with its original whitespace',await reader.locator('#card-body pre code').textContent()===python+'\n');
  await reader.click('#copy');
  check('copying a code card keeps the complete source code',await reader.evaluate(text=>__copiedMarkdown.includes(text),python));
  await reader.locator('#flow button').filter({hasText:'只读编辑器代码'}).click();
  check('read-only editor lines render as a real code block without losing line breaks or embedded backticks',await reader.locator('#card-body pre code').textContent()===javascript+'\n');
  await reader.screenshot({path:join(artifacts,'code-reader-desktop.png')});
  const codeExport=reader.waitForEvent('download'); await reader.click('.settings summary'); await reader.click('#download'); await reader.click('.settings summary');
  const codeDownload=await codeExport; await codeDownload.saveAs(join(artifacts,'code-export.md'));
  const exportedCode=await readFile(join(artifacts,'code-export.md'),'utf8');
  check('Markdown export retains both code blocks exactly once in document order',exportedCode.split(python).length===2&&exportedCode.split(javascript).length===2&&exportedCode.indexOf(python)<exportedCode.indexOf(javascript));
  await chat.evaluate(()=>{ const answer=document.querySelector('[data-chatgpt-search-message-ids="code-a"]'); answer.replaceChildren(); const p=document.createElement('p'); p.textContent='没有 Markdown 标记的正文仍然保留。'; const pre=document.createElement('pre'); const code=document.createElement('code'); code.textContent='print("unmarked")'; pre.append(code); answer.append(p,pre); });
  const unmarkedCode=await waitSnapshot(worker,s=>s?.snapshot.messages.find(m=>m.id==='code-a')?.text.includes('print("unmarked")'));
  check('adding code roots does not drop prose from answers without Markdown markers',unmarkedCode.snapshot.messages.find(m=>m.id==='code-a').text.includes('没有 Markdown 标记的正文仍然保留。'));
  const longCode=Array.from({length:90},(_,i)=>`    print("line ${String(i).padStart(3,'0')}: <tag> & code")`).join('\n');
  await chat.locator('pre code').evaluate((el,text)=>el.textContent=text,longCode);
  await waitSnapshot(worker,s=>s?.snapshot.messages.find(m=>m.id==='code-a')?.text.includes('line 089'));
  await reader.locator('#parts button').last().click();
  check('long generated code stays complete in one code block despite card length limits',await reader.locator('#card-body pre code').textContent()===longCode+'\n');
  await chat.locator('pre code').evaluate(el=>el.textContent+='\n    print("STREAM_END")');
  await reader.waitForFunction(()=>document.querySelector('#card-body pre code')?.textContent.includes('STREAM_END'));
  check('streamed code updates retain all preceding lines',await reader.locator('#card-body pre code').textContent()===longCode+'\n    print("STREAM_END")\n');
  const renderedCodeFixture=await readFile(join(root,'tests/fixtures/rendered-code-blocks.html'),'utf8');
  await context.route('https://chatgpt.com/c/rendered-code-blocks',route=>route.fulfill({contentType:'text/html;charset=utf-8',body:renderedCodeFixture}));
  await chat.goto('https://chatgpt.com/c/rendered-code-blocks');
  const nativeState=await waitSnapshot(worker,s=>s?.snapshot.key.endsWith('/c/rendered-code-blocks')&&s.snapshot.messages.find(m=>m.id==='native-code-a')?.text.includes('os.getcwd()'));
  const nativeAnswer=nativeState.snapshot.messages.find(m=>m.id==='native-code-a');
  const nativePath='D:\\example\\picsun', nativePrompt='You are a coding agent at D:\\example\\picsun.\n\nEnvironment: Windows...\n\nUse bash to solve tasks.\nAct, don\'t explain.';
  check('the supplied editable CodeMirror HTML retains Python code and its content-level language',nativeAnswer.text.includes('```python\nos.getcwd()\n```'));
  check('editable plaintext panels retain paths, blank lines and instruction-like literal text',nativeAnswer.text.includes('```text\n'+nativePath+'\n```')&&nativeAnswer.text.includes(nativePrompt));
  check('allowing assistant code content does not read composers, forms, hidden editors or thinking blocks',!JSON.stringify(nativeState.snapshot).match(/HIDDEN_CODE_SECRET|THINKING_CODE_SECRET|NESTED_DRAFT_SECRET|COMPOSER_CODE_SECRET|复制代码|运行/));
  await reader.waitForFunction(()=>document.querySelector('.answer.active')?.dataset.answer==='native-code-a'&&document.querySelectorAll('#card-body pre code').length===3);
  check('all three native panels display as code blocks in source order',JSON.stringify(await reader.locator('#card-body pre code').allTextContents())===JSON.stringify(['os.getcwd()\n',nativePath+'\n',nativePrompt+'\n']));
  await reader.setViewportSize({width:1480,height:1050});
  await reader.screenshot({path:join(artifacts,'native-code-reader-desktop.png')});
  await reader.click('#copy');
  check('copying the native code card retains every block',await reader.evaluate(([path,prompt])=>__copiedMarkdown.includes('os.getcwd()')&&__copiedMarkdown.includes(path)&&__copiedMarkdown.includes(prompt),[nativePath,nativePrompt]));
  const nativeDownloadEvent=reader.waitForEvent('download'); await reader.click('.settings summary'); await reader.click('#download'); await reader.click('.settings summary');
  const nativeDownload=await nativeDownloadEvent; await nativeDownload.saveAs(join(artifacts,'native-code-export.md'));
  const nativeExport=await readFile(join(artifacts,'native-code-export.md'),'utf8');
  check('exported Markdown contains native panel source exactly once',nativeExport.split('os.getcwd()').length===2&&nativeExport.split(nativePrompt).length===2&&nativeExport.includes('```text\n'+nativePath));
  await chat.locator('.cm-content').first().evaluate(el=>el.querySelector('.cm-line').append(document.createTextNode('\nprint("NATIVE_STREAM")')));
  await reader.waitForFunction(()=>document.querySelector('#card-body pre code')?.textContent.includes('NATIVE_STREAM'));
  check('editable code updates stream into the reader without being reclassified as a draft',await reader.locator('#card-body pre code').first().textContent()==='os.getcwd()\nprint("NATIVE_STREAM")\n');
  await chat.evaluate(()=>{ const editor=document.querySelector('.cm-editor'),content=editor.querySelector('.cm-content'); editor.replaceWith(content); });
  await reader.click('#sync'); await reader.waitForTimeout(850);
  check('a content-level editor without a cm-editor wrapper remains readable',await reader.locator('#card-body pre code').first().textContent()==='os.getcwd()\nprint("NATIVE_STREAM")\n');
  await chat.evaluate(()=>{ const answer=document.querySelector('[data-chatgpt-search-message-ids="native-code-a"]'); answer.querySelector('[data-markdown-text-style]').removeAttribute('data-markdown-text-style'); });
  await reader.click('#sync'); await reader.waitForTimeout(850);
  check('editable output code remains readable outside semantic Markdown containers',await reader.locator('#card-body pre code').count()===3);
  await chat.evaluate(()=>{
    const body=document.querySelector('[data-chatgpt-search-message-ids="native-code-a"]>div'); body.style.cssText='display:flex;flex-direction:column;border:1px solid #555;border-radius:12px;padding:10px';
    for(const button of body.querySelectorAll('.code-toolbar button')) button.insertAdjacentHTML('afterbegin','<svg width="16" height="16"><rect width="12" height="12" fill="none" stroke="white"/></svg>');
    body.querySelector('p').append(document.createTextNode('（面板样式已更新）'));
  });
  const styledCode=await waitSnapshot(worker,s=>s?.snapshot.messages.find(m=>m.id==='native-code-a')?.text.includes('面板样式已更新'));
  check('rounded code panels with toolbar icons remain code rather than being swallowed by diagram capture',!styledCode.snapshot.messages.find(m=>m.id==='native-code-a').visuals?.length&&styledCode.snapshot.messages.find(m=>m.id==='native-code-a').text.includes('os.getcwd()'));
  await chat.evaluate(()=>{document.querySelector('.cm-editor').setAttribute('data-markdown-text-style','assistant-message');});
  await reader.click('#sync'); await reader.waitForTimeout(850);
  check('a code editor recognized through both Markdown and code selectors is included only once',await reader.locator('#card-body pre code').count()===3);
  const plainFixture=await readFile(join(root,'tests/fixtures/plaintext-layout.html'),'utf8');
  await context.route('https://chatgpt.com/c/plaintext-layout',route=>route.fulfill({contentType:'text/html;charset=utf-8',body:plainFixture}));
  await chat.goto('https://chatgpt.com/c/plaintext-layout');
  const tree='messages\n    |\n    |-- user\n    |     查看当前目录\n    |\n    |-- assistant\n          tool_use: dir';
  const boxTree='root\n├── user\n│   └── 查询\n└── assistant\n    └── tool_use';
  const breakText='第一行\n    第二行\n\n        第四行';
  const tabText='root\n\t├── request\tuser\n\t└── result\tassistant_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz';
  const plainState=await waitSnapshot(worker,s=>s?.snapshot.key.endsWith('/c/plaintext-layout')&&s.snapshot.messages.find(m=>m.id==='plain-a')?.text.includes('tool_use: dir'));
  const plainAnswer=plainState.snapshot.messages.find(m=>m.id==='plain-a');
  check('the supplied multiline span inside code becomes a fenced block rather than inline code',plainAnswer.text.includes('```\n'+tree+'\n```'));
  check('preformatted spans and BR-based plaintext preserve whitespace without escaped diagram characters',plainAnswer.text.includes('```\n'+boxTree+'\n```')&&plainAnswer.text.includes('```text\n'+breakText+'\n```'));
  check('plaintext extraction still ignores hidden blocks and forms',!JSON.stringify(plainState.snapshot).match(/HIDDEN_PLAIN_SECRET|DRAFT_PLAIN_SECRET|复制代码/));
  await reader.waitForFunction(()=>document.querySelector('.answer.active')?.dataset.answer==='plain-a');
  await reader.locator('#flow button').filter({hasText:'消息结构'}).click();
  check('the reader displays all seven tree lines with their original indentation',await reader.locator('#card-body pre code').textContent()===tree+'\n');
  const treeLayout=await reader.locator('#card-body pre code').evaluate((el,text)=>{
    const node=el.firstChild,lines=text.split('\n');let offset=0;
    const positions=lines.map(line=>{const indent=line.match(/^ */)[0].length;const range=document.createRange();range.setStart(node,offset+indent);range.setEnd(node,offset+indent+1);const r=range.getBoundingClientRect();offset+=line.length+1;return {x:r.x,y:r.y,width:r.width,indent};});
    const css=getComputedStyle(el);return {positions,lineHeight:parseFloat(css.lineHeight),whiteSpace:css.whiteSpace,font:css.fontFamily};
  },tree);
  check('rendered tree branches occupy separate rows and retain their exact monospace columns',treeLayout.whiteSpace==='pre'&&/monospace/i.test(treeLayout.font)&&treeLayout.positions.every((p,i)=>Math.abs(p.y-treeLayout.positions[0].y-i*treeLayout.lineHeight)<1&&Math.abs(p.x-treeLayout.positions[0].x-p.indent*treeLayout.positions[0].width)<1));
  check('ordinary inline code remains inline beside the surrounding prose',await reader.locator('#card-body p code').count()===1&&await reader.locator('#card-body p code').textContent()==='messages');
  await reader.setViewportSize({width:1480,height:950}); await reader.screenshot({path:join(artifacts,'plaintext-tree-reader.png')});
  await reader.click('#copy');
  check('copying the tree card preserves its original lines and spaces inside a code fence',await reader.evaluate(text=>__copiedMarkdown.includes('```\n'+text+'\n```'),tree));
  await reader.locator('#flow button').filter({hasText:'其他预格式文本'}).click();
  check('Unicode text diagrams and BR-separated text display as separate preformatted blocks',JSON.stringify(await reader.locator('#card-body pre code').allTextContents())===JSON.stringify([boxTree+'\n',breakText+'\n']));
  await reader.locator('#flow button').filter({hasText:'长行与制表符'}).click();
  await reader.setViewportSize({width:390,height:900});
  const narrowText=await reader.locator('#card-body pre').evaluate(el=>{const code=el.querySelector('code'),css=getComputedStyle(code);el.scrollLeft=100;return {tabSize:css.tabSize,whiteSpace:css.whiteSpace,scrollable:el.scrollWidth>el.clientWidth,scrolled:el.scrollLeft>0,overflow:document.documentElement.scrollWidth>innerWidth};});
  check('narrow readers keep tabs at four columns and scroll long lines instead of wrapping the diagram',await reader.locator('#card-body pre code').textContent()===tabText+'\n'&&narrowText.tabSize==='4'&&narrowText.whiteSpace==='pre'&&narrowText.scrollable&&narrowText.scrolled&&!narrowText.overflow);
  await reader.setViewportSize({width:1480,height:950});
  const plainDownloadEvent=reader.waitForEvent('download');await reader.click('.settings summary');await reader.click('#download');await reader.click('.settings summary');
  const plainDownload=await plainDownloadEvent;await plainDownload.saveAs(join(artifacts,'plaintext-export.md'));
  const plainExport=await readFile(join(artifacts,'plaintext-export.md'),'utf8');
  check('exported Markdown retains the tree, Unicode branches, blank lines and tabs exactly once',[tree,boxTree,breakText,tabText].every(text=>plainExport.split(text).length===2));
  await chat.evaluate(()=>{const body=document.querySelector('[data-markdown-text-style]');body.removeAttribute('data-markdown-text-style');for(const el of body.querySelectorAll('p,h2'))el.setAttribute('data-markdown-text-style','assistant-message');body.querySelector('p').append(document.createTextNode('（容器已分开）'));});
  const splitPlain=await waitSnapshot(worker,s=>s?.snapshot.messages.find(m=>m.id==='plain-a')?.text.includes('容器已分开'));
  check('preformatted text survives when it is outside the marked Markdown prose containers',splitPlain.snapshot.messages.find(m=>m.id==='plain-a').text.includes('```\n'+tree+'\n```')&&splitPlain.snapshot.messages.find(m=>m.id==='plain-a').text.includes(boxTree));
  const javaFixture=await readFile(join(root,'tests/fixtures/java-mixed-layout.html'),'utf8');
  await context.route('https://chatgpt.com/c/java-mixed',route=>route.fulfill({contentType:'text/html;charset=utf-8',body:javaFixture}));
  await chat.goto('https://chatgpt.com/c/java-mixed');
  const javaStatements=['boolean result = this.updateById(updatePicture);','ThrowUtils.throwIf(!result, ErrorCode.OPERATION_ERROR);','return ResultUtils.success(true);'];
  const javaSentence='如果 Service 返回 void，但是执行过程中抛出了 BusinessException，Controller 后面的：';
  const javaState=await waitSnapshot(worker,s=>s?.snapshot.key.endsWith('/c/java-mixed')&&s.snapshot.messages.find(m=>m.id==='java-a')?.text.includes('return ResultUtils.success(true);'));
  const javaAnswer=javaState.snapshot.messages.find(m=>m.id==='java-a');
  check('mixed Java prose contains only its three actual code blocks',javaStatements.every(text=>javaAnswer.text.includes('```java\n'+text+'\n```'))&&(javaAnswer.text.match(/^```java$/gm)||[]).length===3&&(javaAnswer.text.match(/^```$/gm)||[]).length===3);
  await reader.waitForFunction(()=>document.querySelector('.answer.active')?.dataset.answer==='java-a');
  await reader.click('.settings summary');await reader.selectOption('#size','relaxed');await reader.click('.settings summary');
  await reader.waitForFunction(()=>document.querySelectorAll('#card-body pre code').length===3);
  check('the reader displays the original three Java statements without empty or invented code blocks',JSON.stringify(await reader.locator('#card-body pre code').allTextContents())===JSON.stringify(javaStatements.map(text=>text+'\n')));
  const sentence=reader.locator('#card-body p').filter({hasText:javaSentence});
  check('explanation text and inline references remain one continuous paragraph',await sentence.count()===1&&(await sentence.textContent())===javaSentence&&await sentence.locator('code').count()===2);
  check('pre-wrap fonts and language classes do not turn inline references into block code',JSON.stringify(await reader.locator('#card-body p code').allTextContents())===JSON.stringify(['doPictureReview()','result','void','BusinessException','ResultUtils.success(true)','doPictureReview( request)']));
  check('inline references inside lists and tables stay inside their original structure',await reader.locator('#card-body li code').count()===2&&await reader.locator('#card-body table code').count()===1);
  check('monospace prose fragments and hidden newlines do not become code blocks',await reader.locator('#card-body p').filter({hasText:'这是一段普通说明，'}).count()===1&&await reader.locator('#card-body pre').filter({hasText:'这是一段普通说明，'}).count()===0);
  const codeHeights=await reader.locator('#card-body pre').evaluateAll(nodes=>nodes.map(el=>el.getBoundingClientRect().height));
  check('single-line Java blocks remain compact without expanded whitespace panels',codeHeights.every(height=>height>30&&height<110));
  await reader.setViewportSize({width:1480,height:1650});await reader.screenshot({path:join(artifacts,'java-mixed-reader.png')});
  await reader.click('#copy');
  check('copying mixed prose preserves the complete question sentence and Java code',await reader.evaluate(([a,b,c])=>__copiedMarkdown.includes(a)&&__copiedMarkdown.includes(b)&&__copiedMarkdown.includes(c),javaStatements)&&await reader.evaluate(()=>__copiedMarkdown.includes('如果 Service 返回 ` void `，但是执行过程中抛出了 ` BusinessException `，Controller 后面的：')));
  await chat.evaluate(()=>{
    const body=document.querySelector('[data-markdown-text-style]');body.removeAttribute('data-markdown-text-style');
    for(const el of body.querySelectorAll('h2,h3,p'))if(!el.matches('.mixed-sentence'))el.setAttribute('data-markdown-text-style','assistant-message');
    for(const el of body.querySelector('.mixed-sentence').children)el.setAttribute('data-markdown-text-style','assistant-message');
    body.querySelector('p').append(document.createTextNode('（片段已重组）'));
  });
  await waitSnapshot(worker,s=>s?.snapshot.messages.find(m=>m.id==='java-a')?.text.includes('片段已重组'));
  await reader.waitForFunction(text=>[...document.querySelectorAll('#card-body p')].some(el=>el.textContent===text),javaSentence);
  check('fragmented inline Markdown markers rejoin their enclosing paragraph',await reader.locator('#card-body p').filter({hasText:javaSentence}).count()===1&&await reader.locator('#card-body pre code').count()===3);
  await reader.setViewportSize({width:390,height:900});
  check('Java prose wraps naturally in the narrow reader while code stays in its own blocks',await reader.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)&&await reader.locator('#card-body pre code').count()===3);
  await reader.setViewportSize({width:1480,height:950});
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
