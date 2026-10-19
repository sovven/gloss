// 网页内：整页双语翻译（仿沉浸式翻译）、悬停 Ctrl 翻译单段、划词翻译

(() => {
  if (window.__hcTranslatorLoaded) return;
  window.__hcTranslatorLoaded = true;

  const IS_TOP = window === window.top;
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

  const TRANS = "hc-imm-trans";
  const HIDE = "hc-imm-hide";

  // ---------- 工具 ----------

  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else if (!res?.ok) reject(new Error(res?.error || "未知错误"));
          else resolve(res);
        });
      } catch (e) {
        reject(new Error("插件已更新，请刷新页面"));
      }
    });
  }

  function applyHtmlClasses() {
    const cl = document.documentElement.classList;
    [...cl].filter((c) => c.startsWith("hc-style-") || c.startsWith("hc-mode-")).forEach((c) => cl.remove(c));
    cl.add("hc-style-" + S.style, "hc-mode-" + S.mode);
  }

  const primary = (l) => (l || "").toLowerCase().split("-")[0];

  // 文本是否已经是目标语言（中日韩可以直接按字符判断，省掉请求）
  function alreadyTarget(text) {
    const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
    if (!letters) return true;
    const t = S.targetLang;
    let re = null;
    if (t.startsWith("zh")) re = /[一-鿿]/g;
    else if (t === "ja") re = /[぀-ヿ一-鿿]/g;
    else if (t === "ko") re = /[가-힯]/g;
    if (!re) return false;
    if (t.startsWith("zh") && /[぀-ヿ]/.test(letters)) return false; // 日文含汉字，不能当中文
    return (letters.match(re) || []).length / letters.length > 0.5;
  }

  // ---------- 段落识别 ----------
  // 思路：把每个块级元素里连续的“行内内容”（文字、链接、加粗……）当成一段，
  // 遇到块级子元素就断开并递归进去。这样各种网页结构都能拆出合理的段落。

  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "template", "textarea", "input", "select", "option", "button",
    "svg", "math", "canvas", "video", "audio", "iframe", "object", "embed", "img", "picture", "head",
  ]);
  const BLOCK_SKIP = new Set(["pre", "code", "kbd", "samp", "var"]);
  const SKIP_ATTR =
    ".notranslate,[translate='no'],[contenteditable=''],[contenteditable='true'],[contenteditable='plaintext-only']";
  const OWN_SEL = `font.${TRANS},.hc-translate-bubble,.hc-translate-trigger`;

  const isOwn = (el) => el.matches(OWN_SEL);
  const displayOf = (el) => getComputedStyle(el).display;

  function isInlineLevel(el, d = displayOf(el)) {
    if (el.localName === "br") return true;
    if (!d.startsWith("inline")) return false;
    for (const c of el.children) {
      if (c.localName === "br" || SKIP_TAGS.has(c.localName)) continue;
      const cd = displayOf(c);
      if (cd !== "none" && !cd.startsWith("inline")) return false;
    }
    return true;
  }

  function nodeText(n) {
    if (n.nodeType === 3) return n.nodeValue.replace(/\s+/g, " ");
    if (n.localName === "br") return "\n";
    if (SKIP_TAGS.has(n.localName)) return "";
    return n.innerText ?? n.textContent ?? "";
  }

  let processed = new WeakSet(); // 已经属于某个段落的节点

  function makeUnit(container, nodes) {
    const blank = (n) => (n.nodeType === 3 ? !n.nodeValue.trim() : n.localName === "br");
    let a = 0;
    let b = nodes.length - 1;
    while (a <= b && blank(nodes[a])) a++;
    while (b >= a && blank(nodes[b])) b--;
    if (a > b) return null;
    nodes = nodes.slice(a, b + 1);
    if (nodes.some((n) => processed.has(n))) return null;
    const text = nodes
      .map(nodeText)
      .join("")
      .replace(/[ \t\r\f\v ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text.length < 2 || text.length > 5000) return null;
    if (!/\p{L}/u.test(text) || alreadyTarget(text)) return null;
    if (/^(https?:\/\/|www\.)\S+$/i.test(text) || /^\S+@\S+\.\S+$/.test(text)) return null;
    return { container, nodes, text, font: null, hidden: false, backup: null };
  }

  function scan(container, out) {
    let run = [];
    const flush = () => {
      if (run.length) {
        // 一排紧挨着的链接/标签（导航栏、标签云）：每个单独翻译，不拼成一句
        const els = run.filter((n) => n.nodeType === 1 && n.localName !== "br");
        const looseText = run.some((n) => n.nodeType === 3 && n.nodeValue.trim());
        const groups = els.length >= 2 && !looseText ? els.map((n) => [n]) : [run];
        for (const g of groups) {
          const u = makeUnit(container, g);
          if (u) out.push(u);
        }
      }
      run = [];
    };
    for (const n of container.childNodes) {
      if (n.nodeType === 3) {
        run.push(n);
        continue;
      }
      if (n.nodeType !== 1 || isOwn(n)) continue;
      const tag = n.localName;
      const skip = SKIP_TAGS.has(tag) || n.matches(SKIP_ATTR);
      const d = displayOf(n);
      if (d === "none") {
        // 隐藏的内容（折叠面板、下拉菜单）也拆好段落，等它显示出来时 IntersectionObserver 会触发翻译
        flush();
        if (!skip && !BLOCK_SKIP.has(tag)) scan(n, out);
      } else if (isInlineLevel(n, d)) {
        run.push(n);
      } else {
        flush();
        if (!skip && !BLOCK_SKIP.has(tag)) scan(n, out);
      }
    }
    flush();
  }

  function blockAncestor(el) {
    while (el && el !== document.body && el.nodeType === 1 && isInlineLevel(el)) el = el.parentElement;
    return el || document.body;
  }

  // ---------- 翻译单元管理 ----------

  const units = new Set();
  const unitByNode = new WeakMap();
  const unitByFont = new WeakMap();
  const anchorMap = new Map(); // 被 IntersectionObserver 观察的元素 -> 等待翻译的段落
  let pending = [];
  let flushTimer = null;
  let pageOn = false;
  let io = null;
  let mo = null;

  function register(list) {
    for (const u of list) {
      u.nodes.forEach((n) => processed.add(n));
      units.add(u);
      if (!io) continue;
      const anchor = u.nodes.find((n) => n.nodeType === 1 && n.localName !== "br") || u.container;
      if (!anchorMap.has(anchor)) {
        anchorMap.set(anchor, []);
        io.observe(anchor);
      }
      anchorMap.get(anchor).push(u);
    }
  }

  function enqueue(u) {
    if (u.font) return;
    const font = document.createElement("font");
    font.className = `${TRANS} hc-imm-loading`;
    font.setAttribute("translate", "no");
    const tag = u.container.localName;
    if (u.text.length <= 30 && !u.text.includes("\n") && !/^(p|h[1-6]|blockquote|dd)$/.test(tag)) {
      font.classList.add("hc-imm-inline");
    }
    u.nodes[u.nodes.length - 1].after(font);
    u.font = font;
    unitByFont.set(font, u);
    u.nodes.forEach((n) => unitByNode.set(n, u));
    pending.push(u);
    if (!flushTimer) flushTimer = setTimeout(flushQueue, 40);
  }

  function flushQueue() {
    flushTimer = null;
    const list = pending;
    pending = [];
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      send({ type: "translateBatch", texts: chunk.map((u) => u.text), title: document.title })
        .then((res) => chunk.forEach((u, k) => fill(u, res.results[k])))
        .catch((e) => chunk.forEach((u) => fail(u, e)));
    }
  }

  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

  function fill(u, r) {
    if (!u.font?.isConnected || !r) return;
    const t = S.targetLang.toLowerCase();
    const lang = (r.lang || "").toLowerCase();
    const same = lang === t || (!t.includes("-") && primary(lang) === t) || (primary(t) !== "zh" && primary(lang) === primary(t));
    if (same || !r.text.trim() || norm(r.text) === norm(u.text)) {
      // 原文已经是目标语言，或者翻译结果和原文一样：不显示
      u.font.remove();
      u.font = "skip";
      return;
    }
    u.font.classList.remove("hc-imm-loading");
    u.font.textContent = r.text;
    applyMode(u);
  }

  function fail(u, e) {
    if (!u.font?.isConnected) return;
    u.font.classList.remove("hc-imm-loading");
    u.font.classList.add("hc-imm-error");
    u.font.textContent = `翻译失败：${e.message}（点击重试）`;
    u.font.title = e.message;
    u.font.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      u.font.remove();
      u.font = null;
      enqueue(u);
    };
  }

  // 仅译文模式：把原文清空/隐藏，切回双语时恢复
  function applyMode(u) {
    const ready = u.font instanceof Element && u.font.isConnected && !u.font.matches(".hc-imm-loading,.hc-imm-error");
    const only = S.mode === "only" && ready;
    if (only && !u.hidden) {
      u.backup = u.nodes.map((n) => (n.nodeType === 3 ? n.nodeValue : null));
      u.nodes.forEach((n) => (n.nodeType === 3 ? (n.nodeValue = "") : n.classList.add(HIDE)));
      u.hidden = true;
    } else if (!only && u.hidden) {
      restore(u);
    }
  }

  function restore(u) {
    u.nodes.forEach((n, i) => (n.nodeType === 3 ? (n.nodeValue = u.backup[i]) : n.classList.remove(HIDE)));
    u.hidden = false;
  }

  function removeUnit(u) {
    if (u.hidden) restore(u);
    if (u.font instanceof Element) u.font.remove();
    u.nodes.forEach((n) => {
      processed.delete(n);
      unitByNode.delete(n);
    });
    units.delete(u);
  }

  // ---------- 整页翻译 ----------

  function startPage() {
    if (pageOn || !document.body) return;
    pageOn = true;
    applyHtmlClasses();
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          const list = anchorMap.get(e.target) || [];
          anchorMap.delete(e.target);
          list.forEach((u) => units.has(u) && enqueue(u));
        }
      },
      { rootMargin: "800px 0px" } // 提前翻译即将滚动到的内容
    );
    const out = [];
    scan(document.body, out);
    register(out);

    // 监听动态加载的内容（无限滚动、单页应用切换页面）
    const dirty = new Set();
    let timer = null;
    mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData") {
          if (!processed.has(m.target) && m.target.parentElement) dirty.add(m.target.parentElement);
          continue;
        }
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && isOwn(n)) continue;
          dirty.add(m.target);
          break;
        }
      }
      if (dirty.size && !timer) {
        timer = setTimeout(() => {
          timer = null;
          const containers = new Set();
          for (const el of dirty) {
            if (!el.isConnected || el.nodeType !== 1) continue;
            if (el.closest(`${OWN_SEL},${SKIP_ATTR},pre,code,textarea,script,style`)) continue;
            containers.add(blockAncestor(el));
          }
          dirty.clear();
          const list = [...containers].filter((c) => ![...containers].some((o) => o !== c && o.contains(c)));
          const found = [];
          list.forEach((c) => scan(c, found));
          register(found);
        }, 300);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopPage() {
    if (!pageOn && !units.size) return;
    pageOn = false;
    io?.disconnect();
    mo?.disconnect();
    io = mo = null;
    anchorMap.clear();
    pending = [];
    [...units].forEach(removeUnit);
    document.querySelectorAll(`font.${TRANS}`).forEach((f) => f.remove());
    processed = new WeakSet();
  }

  function setPage(on) {
    on ? startPage() : stopPage();
  }

  // ---------- 悬停 + Ctrl：翻译/取消鼠标下这一段 ----------

  let hoverEl = null;
  let ctrlAlone = false;
  document.addEventListener("mouseover", (e) => (hoverEl = e.target), true);
  document.addEventListener("mousedown", () => (ctrlAlone = false), true);
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") removeBubble();
      ctrlAlone = e.key === "Control" && !e.repeat ? true : e.key === "Control" ? ctrlAlone : false;
    },
    true
  );
  document.addEventListener(
    "keyup",
    (e) => {
      if (e.key === "Control" && ctrlAlone && hoverEl) toggleAt(hoverEl);
      ctrlAlone = false;
    },
    true
  );

  function toggleAt(t) {
    if (t.nodeType !== 1 || t.closest(".hc-translate-bubble")) return;
    const f = t.closest(`font.${TRANS}`);
    if (f) return unitByFont.get(f) && removeUnit(unitByFont.get(f));
    for (let n = t; n && n !== document.body; n = n.parentNode) {
      const u = unitByNode.get(n);
      if (u && u.font instanceof Element) return removeUnit(u);
    }
    const block = blockAncestor(t);
    const out = [];
    scan(block, out);
    if (!out.length) {
      const u = [...units].find((x) => x.container === block && x.font instanceof Element);
      if (u) removeUnit(u);
      return;
    }
    const u = out.find((x) => x.nodes.some((n) => n === t || n.contains(t))) || out[0];
    u.nodes.forEach((n) => processed.add(n));
    units.add(u);
    enqueue(u);
  }

  // ---------- 划词翻译气泡 ----------

  let bubble = null;
  let trigger = null;

  function removeBubble() {
    bubble?.remove();
    trigger?.remove();
    bubble = trigger = null;
  }

  function selectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    return r.width || r.height ? r : null;
  }

  function place(el, rect) {
    document.documentElement.appendChild(el);
    const maxLeft = window.scrollX + document.documentElement.clientWidth - el.offsetWidth - 8;
    el.style.top = `${window.scrollY + rect.bottom + 8}px`;
    el.style.left = `${Math.max(window.scrollX + 8, Math.min(window.scrollX + rect.left, maxLeft))}px`;
  }

  function showBubble(text, rect) {
    removeBubble();
    bubble = document.createElement("div");
    bubble.className = "hc-translate-bubble";
    bubble.setAttribute("translate", "no");
    bubble.innerHTML = `
      <div class="hc-translate-header">
        <span class="hc-translate-lang">翻译中…</span>
        <span class="hc-translate-actions">
          <button class="hc-copy">复制</button>
          <button class="hc-close">✕</button>
        </span>
      </div>
      <div class="hc-translate-body"></div>`;
    const body = bubble.querySelector(".hc-translate-body");
    const lang = bubble.querySelector(".hc-translate-lang");
    bubble.querySelector(".hc-close").onclick = removeBubble;
    bubble.querySelector(".hc-copy").onclick = (e) => {
      navigator.clipboard.writeText(body.textContent);
      e.target.textContent = "已复制";
    };
    place(bubble, rect || { left: 20, bottom: 20 });

    send({ type: "translate", text })
      .then((res) => {
        if (!bubble) return;
        lang.textContent = `${res.sourceLang} → ${S.targetLang}`;
        body.textContent = res.translated;
      })
      .catch((e) => {
        if (!bubble) return;
        lang.textContent = "翻译失败";
        body.textContent = e.message;
      });
  }

  function showTrigger(text, rect) {
    removeBubble();
    trigger = document.createElement("div");
    trigger.className = "hc-translate-trigger";
    trigger.textContent = "译";
    trigger.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showBubble(text, rect);
    });
    place(trigger, rect);
  }

  document.addEventListener("mouseup", (e) => {
    if (S.selectMode === "off" || e.button !== 0) return;
    if (bubble?.contains(e.target) || trigger?.contains(e.target)) return;
    setTimeout(() => {
      const text = window.getSelection()?.toString().trim();
      if (!text || text.length > 5000 || !/\p{L}/u.test(text)) return;
      const rect = selectionRect();
      if (!rect) return;
      S.selectMode === "auto" ? showBubble(text, rect) : showTrigger(text, rect);
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (bubble?.contains(e.target) || trigger?.contains(e.target)) return;
    removeBubble();
  });

  // ---------- 消息 & 设置 ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "setPage") setPage(msg.on);
    if (msg.type === "showTranslation") showBubble(msg.text, selectionRect());
    if (msg.type === "pageState") sendResponse({ on: pageOn, host: location.hostname });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const k in changes) S[k] = changes[k].newValue ?? DEFAULTS[k];
    applyHtmlClasses();
    if (changes.mode) units.forEach(applyMode);
    if ((changes.targetLang || changes.engine) && pageOn) {
      stopPage();
      startPage();
    }
  });

  // 页面语言是否和目标语言不同（用于“自动翻译外语网页”）
  function isForeign() {
    return new Promise((resolve) => {
      const tgt = primary(S.targetLang);
      const sample = (document.body?.innerText || "").slice(0, 3000);
      if (sample.length < 50) return resolve(false);
      chrome.i18n.detectLanguage(sample, (r) => {
        const top = r?.languages?.[0];
        if (top && r.isReliable) return resolve(primary(top.language) !== tgt);
        const htmlLang = primary(document.documentElement.lang);
        resolve(!!htmlLang && htmlLang !== tgt);
      });
    });
  }

  (async () => {
    S = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
    applyHtmlClasses();
    if (!IS_TOP) {
      // iframe 跟随顶层页面的开关
      const r = await send({ type: "getTab" }).catch(() => null);
      if (r?.on) startPage();
      return;
    }
    let on = S.alwaysSites.includes(location.hostname);
    if (!on && S.autoForeign) on = await isForeign();
    send({ type: "setTab", on }).catch(() => {});
  })();
})();
