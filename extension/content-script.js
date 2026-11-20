(() => {
  const VERSION = '1.2.1';
  if (globalThis.__foldWatcher?.version === VERSION) { globalThis.__foldWatcher.start(); return; }
  globalThis.__foldWatcher?.dispose?.();
  globalThis.__foldWatcher?.stop();
  let observer, timer, routeTimer, signature = '', running = false, sentAt = 0, capturing = false, generation = 0;
  function stop() { running = false; generation++; observer?.disconnect(); document.removeEventListener('load', schedule, true); clearTimeout(timer); clearInterval(routeTimer); timer = null; }
  async function send(force = false) {
    timer = null;
    if (!running) return;
    if (capturing) { schedule(); return; }
    capturing = true;
    const currentGeneration = generation;
    try {
      const snapshot = await FoldCapture.captureRich(document, location.href);
      if (!running || currentGeneration !== generation) return;
      const value = JSON.stringify({ key: snapshot.key, title: snapshot.title, messages: snapshot.messages, diagnostics: snapshot.diagnostics });
      if (!force && value === signature) return;
      signature = value; sentAt = Date.now();
      if (new TextEncoder().encode(value).length > 4_000_000) {
        await chrome.runtime.sendMessage({ type: 'capture:error', code: 'TOO_LARGE' }); return;
      }
      const response = await chrome.runtime.sendMessage({ type: 'capture:snapshot', snapshot });
      if (response?.stop) stop();
    } catch {
      try { await chrome.runtime.sendMessage({ type: 'capture:error', code: 'EXTRACTION_FAILED' }); } catch { /* extension was reloaded */ }
      stop();
    } finally { capturing = false; }
  }
  function schedule() { if (running && !timer) timer = setTimeout(send, Math.max(80, 700 - (Date.now() - sentAt))); }
  function start() {
    if (running) { send(true); return; }
    running = true; signature = '';
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-message-id', 'data-message-role', 'data-message-author-role', 'data-turn', 'data-turn-key', 'data-content-search-unit-key', 'data-chatgpt-search-unit-key', 'data-chatgpt-search-message-ids', 'data-markdown-text-style', 'data-markdown-text-tone', 'aria-hidden'] });
    document.addEventListener('load', schedule, true);
    routeTimer = setInterval(schedule, 1200);
    send(true);
  }
  const onMessage = (message, sender, reply) => {
    if (message.type === 'watch:stop') { stop(); reply({ ok: true }); }
    if (message.type === 'watch:start') { start(); reply({ ok: true }); }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  addEventListener('pagehide', stop);
  const dispose = () => { stop(); document.removeEventListener('load', schedule, true); chrome.runtime.onMessage.removeListener(onMessage); removeEventListener('pagehide', stop); };
  globalThis.__foldWatcher = { version: VERSION, start, stop, dispose };
  start();
})();
