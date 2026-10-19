// 后台：选择翻译引擎、缓存结果，管理每个标签页的翻译开关

importScripts("engines.js");

const DEFAULTS = {
  engine: "google", // google | microsoft | ai
  targetLang: "zh-CN",
  mode: "dual", // dual 双语对照 | only 仅译文
  style: "line", // line | underline | highlight | dim | plain
  selectMode: "button", // off | button | auto  划词翻译
  alwaysSites: [],
  autoForeign: false,
};

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

// ===== 缓存（按引擎 + 目标语言区分） =====
const cache = new Map();
function cacheSet(key, val) {
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  cache.set(key, val);
}

// ===== 批量翻译（整页用） =====
async function translateBatch(texts, ctx, override = {}) {
  const s = await getSettings();
  const engine = override.engine || s.engine;
  const tl = override.targetLang || s.targetLang;
  const eng = ENGINES[engine] || ENGINES.google;
  const keyOf = (t) => `${engine}\u0000${tl}\u0000${t}`;

  const results = new Array(texts.length);
  const missing = [];
  texts.forEach((t, i) => {
    const hit = cache.get(keyOf(t));
    hit ? (results[i] = hit) : missing.push(i);
  });
  if (missing.length) {
    const rs = await eng.translate(missing.map((i) => texts[i]), tl, ctx);
    missing.forEach((i, k) => {
      results[i] = rs[k];
      if (rs[k]?.text) cacheSet(keyOf(texts[i]), rs[k]);
    });
  }
  return results;
}

// ===== 单条翻译（划词、弹窗输入用） =====
async function translateOne(text, override = {}) {
  const s = await getSettings();
  const engine = override.engine || s.engine;
  const tl = override.targetLang || s.targetLang;
  const r =
    engine === "google" ? await ENGINES.google.single(text, tl) : (await translateBatch([text], null, { engine, targetLang: tl }))[0];
  return { translated: r.text, sourceLang: r.lang || "auto" };
}

// ===== 标签页翻译开关（所有 frame 同步） =====
async function getTab(tabId) {
  const key = "tab_" + tabId;
  return !!(await chrome.storage.session.get(key))[key];
}
async function setTab(tabId, on) {
  await chrome.storage.session.set({ ["tab_" + tabId]: on });
  chrome.tabs.sendMessage(tabId, { type: "setPage", on }, () => void chrome.runtime.lastError);
}
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove("tab_" + tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = msg.tabId ?? sender.tab?.id;
  const reply = (p) => {
    p.then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  };
  switch (msg.type) {
    case "translateBatch":
      return reply(translateBatch(msg.texts, { title: msg.title }).then((results) => ({ results })));
    case "translate":
      return reply(translateOne(msg.text, { targetLang: msg.targetLang, engine: msg.engine }));
    case "getTab":
      return reply(getTab(tabId).then((on) => ({ on })));
    case "setTab":
      return reply(setTab(tabId, msg.on).then(() => ({ on: msg.on })));
    case "toggleTab":
      return reply(getTab(tabId).then((on) => setTab(tabId, !on).then(() => ({ on: !on }))));
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  // AI 配置改了，旧的 AI 译文也作废
  if (area === "local" && Object.keys(changes).some((k) => k in AI_DEFAULTS)) {
    for (const k of cache.keys()) if (k.startsWith("ai\u0000")) cache.delete(k);
  }
});

// ===== 右键菜单 & 快捷键 =====
chrome.runtime.onInstalled.addListener(async () => {
  // 补全新版本加入的默认设置
  await chrome.storage.sync.set(await getSettings());
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "translate-selection", title: "翻译「%s」", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "translate-page", title: "翻译此网页 / 显示原文 (Alt+A)", contexts: ["page"] });
  });
});

async function toggle(tabId) {
  await setTab(tabId, !(await getTab(tabId)));
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id == null) return;
  if (info.menuItemId === "translate-selection") {
    chrome.tabs.sendMessage(tab.id, { type: "showTranslation", text: info.selectionText }, { frameId: info.frameId ?? 0 });
  }
  if (info.menuItemId === "translate-page") toggle(tab.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-page" && tab?.id != null) toggle(tab.id);
});
