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

$("version").textContent = "v" + chrome.runtime.getManifest().version;

// 显示实际生效的快捷键；被别的插件占用（为空）时，提示去设置
chrome.commands.getAll((cmds) => {
  const key = cmds.find((c) => c.name === "toggle-page")?.shortcut || "";
  $("keys").replaceChildren(
    ...key.split("+").filter(Boolean).map((k) => Object.assign(document.createElement("kbd"), { textContent: k }))
  );
  $("setKeys").hidden = !!key;
});
$("setKeys").onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
};

// ===== 分段按钮 / 样式预览：点哪个就存哪个 =====
document.querySelectorAll("[data-key]").forEach((group) => {
  const key = group.dataset.key;
  group.querySelectorAll("[data-v]").forEach((btn) => {
    btn.onclick = () => {
      chrome.storage.sync.set({ [key]: btn.dataset.v });
      S[key] = btn.dataset.v;
      render();
    };
  });
});

$("targetLang").onchange = () => chrome.storage.sync.set({ targetLang: $("targetLang").value });
$("autoForeign").onchange = () => chrome.storage.sync.set({ autoForeign: $("autoForeign").checked });
document.querySelectorAll("[data-options]").forEach(
  (a) =>
    (a.onclick = (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    })
);

function render() {
  document.querySelectorAll("[data-key]").forEach((group) => {
    group.querySelectorAll("[data-v]").forEach((b) => b.classList.toggle("active", b.dataset.v === S[group.dataset.key]));
  });
  $("targetLang").value = S.targetLang;
  $("autoForeign").checked = S.autoForeign;
  $("always").checked = !!host && S.alwaysSites.includes(host);
  $("always").disabled = !host;
  if (host) $("alwaysTxt").textContent = `总是翻译 ${host}`;
  renderAi();
}

// 选了 AI：显示当前模型；没填 Key 就提醒
function renderAi() {
  const on = S.engine === "ai";
  $("aiRow").hidden = !on;
  if (!on) return;
  chrome.storage.local.get(
    { aiProvider: "claude", claudeKey: "", claudeModel: "claude-opus-5-5", openaiKey: "", openaiModel: "deepseek-chat" },
    (c) => {
      const claude = c.aiProvider === "claude";
      const hasKey = claude ? c.claudeKey : c.openaiKey;
      const model = claude ? c.claudeModel.replace("claude-", "Claude ").replace(/-(\d)-(\d)$/, " $1.$2") : c.openaiModel;
      $("aiInfo").textContent = hasKey ? `正在使用 ${model}` : "还没有填写 API Key";
      $("aiInfo").style.color = hasKey ? "" : "var(--bad)";
    }
  );
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  S = s;
  render();
});

$("always").onchange = () => {
  const list = S.alwaysSites.filter((h) => h !== host);
  if ($("always").checked) list.push(host);
  S.alwaysSites = list;
  chrome.storage.sync.set({ alwaysSites: list });
  if ($("always").checked) setPage(true);
};

// ===== Google 连不上时的提示 =====
chrome.storage.session.get({ googleFallback: 0 }, ({ googleFallback }) => {
  $("fallback").hidden = !(googleFallback && Date.now() - googleFallback < 30 * 60 * 1000 && S.engine === "google");
});
$("useMs").onclick = () => {
  chrome.storage.sync.set({ engine: "microsoft" });
  chrome.storage.session.remove("googleFallback");
  S.engine = "microsoft";
  $("fallback").hidden = true;
  render();
};

// ===== 整页翻译按钮 & 状态 =====
function setPageBtn(on) {
  $("page").querySelector(".label").textContent = on ? "显示原文" : "翻译此网页";
  $("page").classList.toggle("on", on);
  $("status").textContent = on ? "已翻译" : "未翻译";
  $("status").classList.toggle("on", on);
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
      $("page").querySelector(".label").textContent = "这个页面不能翻译";
      $("status").textContent = "不可用";
      $("page").title = "浏览器自带页面不允许插件运行；刚安装插件的话，请先刷新网页";
      return;
    }
    host = res.host;
    setPageBtn(res.on);
    render();
  });
});

$("page").onclick = () => {
  chrome.runtime.sendMessage({ type: "toggleTab", tabId: tab.id }, (res) => {
    if (res?.ok) setPageBtn(res.on);
    window.close();
  });
};

// ===== 输入翻译 =====
$("quickToggle").onclick = (e) => {
  e.preventDefault();
  $("quick").hidden = !$("quick").hidden;
  if (!$("quick").hidden) $("input").focus();
};
function run() {
  const text = $("input").value.trim();
  if (!text) return;
  $("result").textContent = "翻译中…";
  chrome.runtime.sendMessage({ type: "translate", text, targetLang: S.targetLang, engine: S.engine }, (res) => {
    $("result").textContent = res?.ok ? res.translated : "翻译失败：" + (res?.error || "未知错误");
  });
}
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) run();
});
