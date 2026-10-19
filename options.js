const $ = (id) => document.getElementById(id);
const AI_DEFAULTS = {
  aiProvider: "claude",
  claudeKey: "",
  claudeModel: "claude-opus-5-5",
  openaiBase: "https://api.deepseek.com",
  openaiKey: "",
  openaiModel: "deepseek-chat",
};
const FIELDS = ["claudeKey", "openaiBase", "openaiKey", "openaiModel"];

const provider = () => document.querySelector("input[name=provider]:checked").value;

function showProvider() {
  $("claudeBox").hidden = provider() !== "claude";
  $("openaiBox").hidden = provider() !== "openai";
}

function status(text, cls = "") {
  $("status").textContent = text;
  $("status").className = cls;
}

chrome.storage.local.get(AI_DEFAULTS, (c) => {
  document.querySelector(`input[name=provider][value=${c.aiProvider}]`).checked = true;
  FIELDS.forEach((k) => ($(k).value = c[k]));
  const model = document.querySelector(`input[name=claudeModel][value="${c.claudeModel}"]`) || document.querySelector("input[name=claudeModel]");
  model.checked = true;
  showProvider();
});

document.querySelectorAll("input[name=provider]").forEach((r) => (r.onchange = showProvider));
document.querySelectorAll(".presets button").forEach(
  (b) =>
    (b.onclick = () => {
      $("openaiBase").value = b.dataset.base;
      $("openaiModel").value = b.dataset.model;
    })
);

// 自定义接口地址需要先拿到访问那个网站的权限
async function ensurePermission() {
  if (provider() !== "openai") return true;
  let origin;
  try {
    origin = new URL($("openaiBase").value.trim()).origin + "/*";
  } catch {
    status("接口地址格式不对", "bad");
    return false;
  }
  const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
  if (!granted) status("没有获得访问该接口的权限", "bad");
  return granted;
}

async function save() {
  if (!(await ensurePermission())) return false;
  const data = { aiProvider: provider() };
  FIELDS.forEach((k) => (data[k] = $(k).value.trim()));
  data.claudeModel = document.querySelector("input[name=claudeModel]:checked").value;
  await chrome.storage.local.set(data);
  // 保存后顺便把翻译服务切到 AI
  await chrome.storage.sync.set({ engine: "ai" });
  return true;
}

$("save").onclick = async () => {
  if (await save()) status("✓ 已保存，翻译服务已切换为 AI", "ok");
};

$("test").onclick = async () => {
  if (!(await save())) return;
  status("测试中…");
  const t0 = Date.now();
  chrome.runtime.sendMessage(
    { type: "translate", text: "The quick brown fox jumps over the lazy dog.", engine: "ai" },
    (res) => {
      if (res?.ok) status(`✓ 成功（${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${res.translated}`, "ok");
      else status("失败：" + (res?.error || chrome.runtime.lastError?.message || "未知错误"), "bad");
    }
  );
};
