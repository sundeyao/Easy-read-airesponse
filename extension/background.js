const KEY = 'foldSession';
const allowed = url => { try { const u = new URL(url); return u.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(u.hostname); } catch { return false; } };
let session = { status: 'idle', tabId: null, snapshot: null, error: '' };
const ready = chrome.storage.session.get(KEY).then(data => { if (data[KEY]) session = data[KEY]; });
let queue = Promise.resolve();
const serial = operation => { const result = queue.then(() => ready).then(operation); queue = result.catch(() => {}); return result; };
const save = () => chrome.storage.session.set({ [KEY]: session });
const tell = (tabId, type) => chrome.tabs.sendMessage(tabId, { type }).catch(() => {});
async function attach(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!allowed(tab.url)) throw new Error('先打开 ChatGPT 对话，再点击浏览器工具栏中的折页图标。');
  if (session.tabId && session.tabId !== tabId) await tell(session.tabId, 'watch:stop');
  session = { ...session, tabId, status: 'connecting', error: '' }; await save();
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['capture-core.js', 'content-script.js'] });
  } catch {
    session.status = 'error'; session.error = '页面读取权限已失效，请回到 ChatGPT 页面，再点击一次折页图标。'; await save();
  }
}
chrome.action.onClicked.addListener(tab => {
  // Must run immediately inside the action's user gesture.
  const panel = chrome.sidePanel.open({ windowId: tab.windowId });
  panel.catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('reader.html') }));
  serial(async () => {
    if (!allowed(tab.url)) { session.error = '请在 ChatGPT 对话页点击折页图标。'; await save(); return; }
    await attach(tab.id);
  }).catch(console.error);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message.type !== 'string') return;
  serial(async () => {
    if (message.type.startsWith('capture:')) {
      if (!sender.tab || sender.frameId !== 0 || sender.tab.id !== session.tabId || !allowed(sender.url) || !['connecting', 'live', 'empty'].includes(session.status)) return { stop: true };
      if (message.type === 'capture:error') {
        session.error = message.code === 'TOO_LARGE' ? '当前内容超过读取大小限制，请减少已加载内容后重新同步。' : '消息提取失败。请刷新原对话页，再点击折页图标；仍失败时请复制诊断信息。';
        session.status = 'error'; await save(); return { stop: true };
      }
      const s = message.snapshot;
      const tab = await chrome.tabs.get(sender.tab.id);
      if (!s || !allowed(tab.url) || new URL(s.url).origin + new URL(s.url).pathname !== new URL(tab.url).origin + new URL(tab.url).pathname || !Array.isArray(s.messages)) return { stop: false };
      const snapshot = {
        key: new URL(s.url).origin + new URL(s.url).pathname.replace(/\/$/, ''), url: s.url,
        title: String(s.title || '当前对话').slice(0, 200), capturedAt: Date.now(), scope: s.scope,
        messages: s.messages.filter(m => ['assistant', 'user'].includes(m.role) && typeof m.text === 'string').map(m => ({ id: String(m.id), role: m.role, text: m.text })),
        diagnostics: Object.fromEntries(['version', 'legacyMarkers', 'searchUnits', 'turnShells', 'bodyMarkers', 'timelines', 'strategy', 'recognized', 'readyState'].filter(key => ['number', 'string'].includes(typeof s.diagnostics?.[key])).map(key => [key, s.diagnostics[key]]))
      };
      if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 4_000_000) return { stop: true };
      const empty = !snapshot.messages.length;
      session = { ...session, snapshot, status: empty ? 'empty' : 'live', error: empty ? '已连接页面，但尚未识别到消息。请刷新原对话页后再次点击折页图标；仍为空时可复制诊断信息。' : '' }; await save(); return { ok: true };
    }
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('reader.html'))) return { error: '无效请求' };
    if (message.type === 'reader:pause') { if (session.tabId) await tell(session.tabId, 'watch:stop'); session.status = 'paused'; session.error = ''; await save(); }
    if (message.type === 'reader:resume') { if (!session.tabId) throw new Error('先在 ChatGPT 页面点击折页图标。'); await attach(session.tabId); }
    if (message.type === 'reader:source') {
      if (session.tabId) { const tab = await chrome.tabs.get(session.tabId); await chrome.windows.update(tab.windowId, { focused: true }); await chrome.tabs.update(tab.id, { active: true }); }
      else throw new Error('先在 ChatGPT 页面点击折页图标。');
    }
    if (message.type === 'reader:expand') await chrome.tabs.create({ url: chrome.runtime.getURL('reader.html?view=tab') });
    if (message.type === 'reader:clear') {
      if (session.tabId) await tell(session.tabId, 'watch:stop');
      session = { status: 'idle', tabId: null, snapshot: null, error: '' }; await save();
    }
    return { ok: true };
  }).then(reply, error => reply({ error: error.message || '操作失败，请重新点击扩展图标。' }));
  return true;
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'complete') return;
  serial(async () => {
    if (tabId !== session.tabId || !['live', 'connecting', 'empty'].includes(session.status)) return;
    const tab = await chrome.tabs.get(tabId);
    if (allowed(tab.url)) await attach(tabId);
    else { session.status = 'disconnected'; session.error = '原标签已离开 ChatGPT。返回对话页后，点击折页图标重新连接。'; await save(); }
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => serial(async () => {
  if (tabId === session.tabId) { session.status = 'closed'; session.tabId = null; session.error = ''; await save(); }
}).catch(() => {}));
