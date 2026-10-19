const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  engine: "google",
  targetLang: "zh-CN",
  mode: "dual",
  style: "line",
  selectMode: "button",
  alwaysSites: [],
  autoForeign: false,
};

let S = { ...DEFAULTS };
let tab = null;
let host = null;

// ===== 设置 =====
chrome.storage.sync.get(DEFAULTS, (s) => {
  S = s;
  for (const k of ["engine", "targetLang", "mode", "style", "selectMode"]) $(k).value = S[k];
  $("autoForeign").checked = S.autoForeign;
  refreshAlways();
  refreshAi();
});

for (const k of ["engine", "targetLang", "mode", "style", "selectMode"]) {
  $(k).onchange = () => chrome.storage.sync.set({ [k]: $(k).value });
}
$("engine").addEventListener("change", refreshAi);
$("openOptions").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

// 选了 AI 翻译时，显示当前用的模型；没填 Key 就提醒
function refreshAi() {
  const on = $("engine").value === "ai";
  $("aiHint").hidden = !on;
  if (!on) return;
  chrome.storage.local.get({ aiProvider: "claude", claudeKey: "", claudeModel: "claude-opus-5-5", openaiKey: "", openaiModel: "deepseek-chat" }, (c) => {
    const claude = c.aiProvider === "claude";
    const hasKey = claude ? c.claudeKey : c.openaiKey;
    $("aiInfo").textContent = hasKey ? `当前模型：${claude ? c.claudeModel : c.openaiModel}` : "还没有填写 API Key";
    $("aiInfo").classList.toggle("warn", !hasKey);
  });
}

$("autoForeign").onchange = () => chrome.storage.sync.set({ autoForeign: $("autoForeign").checked });

function refreshAlways() {
  if (!host) {
    $("always").disabled = true;
    return;
  }
  $("always").disabled = false;
  $("alwaysTxt").textContent = `总是翻译 ${host}`;
  $("always").checked = S.alwaysSites.includes(host);
}

$("always").onchange = () => {
  const list = S.alwaysSites.filter((h) => h !== host);
  if ($("always").checked) list.push(host);
  S.alwaysSites = list;
  chrome.storage.sync.set({ alwaysSites: list });
  if ($("always").checked) setPage(true);
};

// ===== 整页翻译按钮 =====
function setPageBtn(on) {
  $("page").textContent = on ? "显示原文" : "翻译此网页";
  $("page").classList.toggle("on", on);
}

function setPage(on) {
  chrome.runtime.sendMessage({ type: "setTab", tabId: tab.id, on }, (res) => res?.ok && setPageBtn(on));
}

chrome.tabs.query({ active: true, currentWindow: true }, ([t]) => {
  tab = t;
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "pageState" }, { frameId: 0 }, (res) => {
    if (chrome.runtime.lastError || !res) {
      $("page").disabled = true;
      $("page").textContent = "此页面不能翻译（新装插件请先刷新页面）";
      return;
    }
    host = res.host;
    setPageBtn(res.on);
    refreshAlways();
  });
});

$("page").onclick = () => {
  chrome.runtime.sendMessage({ type: "toggleTab", tabId: tab.id }, (res) => {
    if (res?.ok) setPageBtn(res.on);
    window.close();
  });
};

// ===== 输入翻译 =====
function run() {
  const text = $("input").value.trim();
  if (!text) return;
  $("result").textContent = "翻译中…";
  chrome.runtime.sendMessage({ type: "translate", text, targetLang: $("targetLang").value, engine: $("engine").value }, (res) => {
    $("result").textContent = res?.ok ? res.translated : "翻译失败：" + (res?.error || "未知错误");
  });
}

$("go").onclick = run;
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) run();
});
