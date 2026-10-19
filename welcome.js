const $ = (id) => document.getElementById(id);

// 显示实际生效的快捷键
chrome.commands.getAll((cmds) => {
  const key = cmds.find((c) => c.name === "toggle-page")?.shortcut || "";
  $("keys").replaceChildren(
    ...(key ? key.split("+") : ["未设置"]).map((k) => Object.assign(document.createElement("kbd"), { textContent: k }))
  );
});

$("shortcuts").onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
};
$("options").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

// ===== 翻译服务选择 =====
const seg = document.querySelector("[data-key=engine]");
function renderEngine(engine) {
  seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === engine));
}
seg.querySelectorAll("button").forEach(
  (b) =>
    (b.onclick = () => {
      chrome.storage.sync.set({ engine: b.dataset.v });
      renderEngine(b.dataset.v);
      if (b.dataset.v === "ai") chrome.runtime.openOptionsPage();
    })
);

// 检测 Google 能不能连上；连不上（比如在中国大陆）就自动改用微软翻译
chrome.storage.sync.get({ engine: "google" }, async ({ engine }) => {
  renderEngine(engine);
  const net = $("net");
  try {
    const res = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=hi", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(res.status);
    net.textContent = "✓ Google 翻译可以正常使用。";
    net.className = "ok";
  } catch {
    if (engine === "google") {
      chrome.storage.sync.set({ engine: "microsoft" });
      renderEngine("microsoft");
      net.textContent = "Google 翻译连不上，已经自动切换到微软翻译（免费，国内可以直接用）。";
    } else {
      net.textContent = "Google 翻译连不上，建议使用微软翻译。";
    }
    net.className = "warn";
  }
});
