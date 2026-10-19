// Gloss 网页内脚本：整页双语对照、悬停 Ctrl 翻译单段、划词翻译

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
    return (letters.match(re) || []).length / letters.length > (t.startsWith("zh") ? 0.3 : 0.5);
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
  const OWN_SEL = `font.${TRANS},hc-translator-ui`;
  // 其他翻译插件（沉浸式翻译、陪读蛙）插进网页的译文：别再翻译它，也别重复翻译它已经翻过的段落
  const OTHER_SEL = '[class*="immersive-translate"],[data-immersive-translate-translation-element-mark],[class*="read-frog"]';

  // 界面元素（导航、菜单、工具栏、标签页）不是要读的内容，默认不翻译；悬停按 Ctrl 仍可单独翻译
  const UI_SEL = "nav,[role=navigation],[role=menu],[role=menubar],[role=toolbar],[role=tablist],[role=tab],[role=search]";

  // 个别网站的专门规则：skip = 不翻译的区域；content = 一定要翻译的正文（不受“短链接不翻译”限制）
  const SITE_RULES = [
    {
      host: /(^|\.)youtube\.com$/,
      skip:
        "#masthead-container,#guide,ytd-mini-guide-renderer,ytd-channel-name,#channel-info,#byline-container," +
        "#metadata-line,ytd-video-meta-block,yt-chip-cloud-renderer,ytd-feed-filter-chip-bar-renderer," +
        "ytd-badge-supported-renderer,ytd-thumbnail,ytd-thumbnail-overlay-time-status-renderer," +
        "ytd-expandable-metadata-renderer,ytd-menu-renderer,#subscribe-button,ytd-video-owner-renderer," +
        "#owner,#header-author,tp-yt-paper-tooltip,ytd-search-filter-renderer,yt-formatted-string#count," +
        "yt-content-metadata-view-model,yt-avatar-shape,yt-decorated-avatar-view-model,#movie_player,#player-ads," +
        "ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer,ytd-promoted-sparkles-web-renderer,ytd-player-legacy-desktop-watch-ads-renderer",
      content:
        "#video-title,#content-text,#description-text,.metadata-snippet-text,#title h1,#description," +
        ".yt-lockup-metadata-view-model__title,.yt-lockup-metadata-view-model__heading-reset",
    },
  ];
  const site = SITE_RULES.find((r) => r.host.test(location.hostname)) || {};
  const SKIP_SEL = site.skip ? `${UI_SEL},${site.skip}` : UI_SEL;

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

  // 短链接、短按钮多半是人名、频道名、菜单项，翻译了反而添乱
  const LINK_SEL = "a,button,label,[role=link],[role=button],[role=option],[role=menuitem]";
  function isShortLabel(text, nodes, container) {
    const el = nodes.find((n) => n.nodeType === 1) || container;
    if (site.content && el.closest(site.content)) return false;
    const short = /\s/.test(text) ? text.split(/\s+/).length <= 3 && text.length <= 30 : text.length <= 12;
    if (!short) return false;
    if (el.closest(LINK_SEL)) return true;
    // 只包着链接的元素，比如列表项 <li><a>drums</a></li>
    const links = nodes.flatMap((n) => (n.nodeType === 1 ? [...n.querySelectorAll(LINK_SEL)] : []));
    const linkText = links.map((a) => a.textContent).join("").replace(/\s+/g, "");
    return linkText.length > 0 && linkText === text.replace(/\s+/g, "");
  }

  // force = 用户主动要求翻译（悬停按 Ctrl），跳过“看起来不像正文”的过滤
  function makeUnit(container, nodes, force = false) {
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
    if (!force) {
      if (/^[A-Z0-9]{1,4}$/.test(text)) return null; // KR、VIP、HD 这类代码
      if (/^[#@]\S+$/.test(text)) return null; // 话题标签 #爵士、@提及
      if (isShortLabel(text, nodes, container)) return null;
      const w = container.getBoundingClientRect().width;
      if (w > 0 && w < 80) return null; // 太窄的位置放不下译文，会被挤成竖排
    }
    return { container, nodes, text, font: null, hidden: false, backup: null };
  }

  function scan(container, out, force = false) {
    let run = [];
    let other = false; // 这一段后面跟着其他插件的译文
    const flush = () => {
      if (run.length && (force || !other)) {
        // 一排紧挨着的链接/标签（导航栏、标签云）：每个单独翻译，不拼成一句
        const els = run.filter((n) => n.nodeType === 1 && n.localName !== "br");
        const looseText = run.some((n) => n.nodeType === 3 && n.nodeValue.trim());
        const groups = els.length >= 2 && !looseText ? els.map((n) => [n]) : [run];
        for (const g of groups) {
          const u = makeUnit(container, g, force);
          if (u) out.push(u);
        }
      }
      run = [];
      other = false;
    };
    for (const n of container.childNodes) {
      if (n.nodeType === 3) {
        run.push(n);
        continue;
      }
      if (n.nodeType !== 1 || isOwn(n)) continue;
      if (n.matches(OTHER_SEL)) {
        other = true;
        continue;
      }
      const tag = n.localName;
      if (!force && n.matches(SKIP_SEL)) {
        flush(); // 界面元素：整块跳过
        continue;
      }
      const skip = SKIP_TAGS.has(tag) || n.matches(SKIP_ATTR);
      const d = displayOf(n);
      if (d === "none") {
        // 隐藏的内容（折叠面板、下拉菜单）也拆好段落，等它显示出来时 IntersectionObserver 会触发翻译
        flush();
        if (!skip && !BLOCK_SKIP.has(tag)) scan(n, out, force);
      } else if (isInlineLevel(n, d)) {
        run.push(n);
      } else {
        flush();
        if (!skip && !BLOCK_SKIP.has(tag)) scan(n, out, force);
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
      u.nodes.forEach((n) => {
        processed.add(n);
        unitByNode.set(n, u);
      });
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
    unclamp(u.font);
  }

  // 很多网站（YouTube 标题、卡片摘要）限制文字最多显示 2 行，加在下面的译文会被裁掉：解除这个限制
  function unclamp(font) {
    let el = font.parentElement;
    for (let i = 0; el && el !== document.body && i < 4; i++, el = el.parentElement) {
      const cs = getComputedStyle(el);
      const clamped = cs.webkitLineClamp !== "none" || (cs.maxHeight !== "none" && cs.overflowY === "hidden");
      if (clamped && el.scrollHeight > el.clientHeight + 1) el.classList.add("hc-imm-unclamp");
    }
  }

  function fail(u, e) {
    if (!u.font?.isConnected) return;
    u.font.classList.remove("hc-imm-loading");
    u.font.classList.add("hc-imm-error");
    u.font.textContent = "翻译失败 · 点击重试";
    u.font.title = e.message;
    u.font.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      u.font.remove();
      u.font = null;
      enqueue(u);
    };
  }

  const selfSet = new WeakMap(); // 插件自己改过的文字节点 → 改成的值

  // 仅译文模式：把原文清空/隐藏，切回双语时恢复
  function applyMode(u) {
    const ready = u.font instanceof Element && u.font.isConnected && !u.font.matches(".hc-imm-loading,.hc-imm-error");
    const only = S.mode === "only" && ready;
    if (only && !u.hidden) {
      u.backup = u.nodes.map((n) => (n.nodeType === 3 ? n.nodeValue : null));
      u.nodes.forEach((n) => (n.nodeType === 3 ? (selfSet.set(n, ""), (n.nodeValue = "")) : n.classList.add(HIDE)));
      u.hidden = true;
    } else if (!only && u.hidden) {
      restore(u);
    }
  }

  function restore(u) {
    u.nodes.forEach((n, i) => {
      if (n.nodeType !== 3) return n.classList.remove(HIDE);
      if (n.nodeValue !== "") return; // 网页已经换上了新文字，不要覆盖
      selfSet.set(n, u.backup[i]);
      n.nodeValue = u.backup[i];
    });
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
          const t = m.target;
          if (selfSet.has(t) && selfSet.get(t) === t.nodeValue) continue; // 插件自己改的
          const u = unitByNode.get(t);
          if (u) removeUnit(u);
          if (t.parentElement) dirty.add(t.parentElement);
          continue;
        }
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 && isOwn(n)) continue; // 译文本身被移除（多半是插件自己）
          const u = unitByNode.get(n);
          if (u) removeUnit(u); // 原文被网页换掉了：旧译文也删掉，新内容会重新翻译
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
            if (el.closest(`${OWN_SEL},${SKIP_ATTR},${SKIP_SEL},pre,code,textarea,script,style`)) continue;
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
    document.querySelectorAll(".hc-imm-unclamp").forEach((el) => el.classList.remove("hc-imm-unclamp"));
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
    if (t.nodeType !== 1 || t.closest("hc-translator-ui")) return;
    const f = t.closest(`font.${TRANS}`);
    if (f) return unitByFont.get(f) && removeUnit(unitByFont.get(f));
    for (let n = t; n && n !== document.body; n = n.parentNode) {
      const u = unitByNode.get(n);
      if (u && u.font instanceof Element) return removeUnit(u);
    }
    const block = blockAncestor(t);
    const out = [];
    scan(block, out, true);
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

  // ---------- 划词翻译气泡（Shadow DOM：不受网页 CSS 影响） ----------

  const UI_TAG = "hc-translator-ui";
  const ICON_LOGO =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h6A2.5 2.5 0 0 1 15 6.5v3A2.5 2.5 0 0 1 12.5 12H8l-2.5 2v-2A2.5 2.5 0 0 1 4 9.5v-3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M11 13.5A2.5 2.5 0 0 1 13.5 11h4A2.5 2.5 0 0 1 20 13.5v3a2.5 2.5 0 0 1-2.5 2.5V21L15 19h-1.5a2.5 2.5 0 0 1-2.5-2.5v-3Z" fill="#10b981"/></svg>';
  const ICON_COPY =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#10b981" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const UI_CSS = `
    :host { all: initial; position: absolute; z-index: 2147483647; }
    * { box-sizing: border-box; }
    .wrap {
      --bg: #fff; --text: #111827; --muted: #6b7280; --border: rgba(15,23,42,.08); --fill: #f2f3f5; --skel: #eceef1;
      font: 14px/1.6 "Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei UI",sans-serif;
      color: var(--text); -webkit-font-smoothing: antialiased;
      animation: in .14s cubic-bezier(.2,.8,.3,1);
    }
    @media (prefers-color-scheme: dark) {
      .wrap { --bg: #1c1d20; --text: #f3f4f6; --muted: #9ca3af; --border: rgba(255,255,255,.09); --fill: #2a2b30; --skel: #2a2b30; }
    }
    @keyframes in { from { opacity: 0; transform: translateY(4px) scale(.98); } }
    .trigger {
      width: 30px; height: 30px; border-radius: 10px; display: grid; place-items: center; cursor: pointer;
      background: var(--bg); color: var(--text); border: 1px solid var(--border);
      box-shadow: 0 4px 14px -2px rgba(15,23,42,.18), 0 1px 2px rgba(15,23,42,.06);
      transition: transform .12s, box-shadow .12s;
    }
    .trigger:hover { transform: translateY(-1px) scale(1.05); box-shadow: 0 8px 20px -4px rgba(15,23,42,.25); }
    .card {
      width: min(380px, calc(100vw - 16px)); background: var(--bg); border: 1px solid var(--border); border-radius: 14px;
      box-shadow: 0 16px 40px -12px rgba(15,23,42,.28), 0 2px 6px rgba(15,23,42,.06); overflow: hidden;
    }
    .head { display: flex; align-items: center; gap: 4px; padding: 10px 8px 4px 14px; }
    .lang { flex: 1; display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 500; color: var(--muted); }
    .lang b { font-weight: 600; color: var(--text); }
    button {
      all: unset; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center;
      color: var(--muted); cursor: pointer; transition: background .12s, color .12s;
    }
    button:hover { background: var(--fill); color: var(--text); }
    .body { padding: 4px 16px 14px; font-size: 15px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
    .body.err { color: #dc2626; font-size: 13px; }
    .skel i { display: block; height: 10px; margin: 8px 0; border-radius: 5px; background: var(--skel); animation: pulse 1.2s ease-in-out infinite; }
    .skel i:nth-child(2) { width: 85%; } .skel i:nth-child(3) { width: 55%; }
    @keyframes pulse { 50% { opacity: .45; } }
  `;

  let ui = null; // 当前显示的气泡或按钮

  function removeBubble() {
    ui?.host.remove();
    ui = null;
  }

  function mountUi() {
    removeBubble();
    const host = document.createElement(UI_TAG);
    host.setAttribute("translate", "no");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${UI_CSS}</style><div class="wrap"></div>`;
    document.documentElement.appendChild(host);
    ui = { host, wrap: root.querySelector(".wrap") };
    return ui;
  }

  // 放在选中文字下方；右边放不下就往左挪，下面放不下就放到上方
  function place(rect) {
    const { host } = ui;
    const vw = document.documentElement.clientWidth;
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, vw - w - 8));
    const below = rect.bottom + 8;
    const top = below + h > window.innerHeight - 8 && rect.top - h - 8 > 8 ? rect.top - h - 8 : below;
    host.style.left = `${window.scrollX + left}px`;
    host.style.top = `${window.scrollY + top}px`;
  }

  function selectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    return r.width || r.height ? r : null;
  }

  let langNames = null;
  function langName(code) {
    if (!code || code === "auto") return "自动检测";
    const fixed = { "zh-CN": "简体中文", "zh-TW": "繁體中文", zh: "中文" }[code];
    if (fixed) return fixed;
    try {
      langNames ??= new Intl.DisplayNames(["zh-CN"], { type: "language" });
      return langNames.of(code) || code;
    } catch {
      return code;
    }
  }

  function showBubble(text, rect) {
    rect ||= { left: 20, top: 20, bottom: 20 };
    const { wrap } = mountUi();
    wrap.innerHTML = `
      <div class="card">
        <div class="head">
          <span class="lang">${ICON_LOGO}<span class="langtext">翻译中…</span></span>
          <button class="copy" title="复制译文">${ICON_COPY}</button>
          <button class="close" title="关闭 (Esc)">${ICON_CLOSE}</button>
        </div>
        <div class="body skel"><i></i><i></i><i></i></div>
      </div>`;
    const body = wrap.querySelector(".body");
    const langText = wrap.querySelector(".langtext");
    const copy = wrap.querySelector(".copy");
    wrap.querySelector(".close").onclick = removeBubble;
    copy.onclick = () => {
      navigator.clipboard.writeText(body.textContent).catch(() => {}); // 浏览器不给剪贴板权限时不报错
      copy.innerHTML = ICON_CHECK;
      setTimeout(() => (copy.innerHTML = ICON_COPY), 1200);
    };
    place(rect);
    const mine = ui;

    send({ type: "translate", text })
      .then((res) => {
        if (ui !== mine) return;
        const from = document.createElement("span");
        from.textContent = langName(res.sourceLang) + " → ";
        const to = document.createElement("b");
        to.textContent = langName(S.targetLang);
        langText.replaceChildren(from, to);
        body.className = "body";
        body.textContent = res.translated;
        place(rect);
      })
      .catch((e) => {
        if (ui !== mine) return;
        langText.textContent = "翻译失败";
        body.className = "body err";
        body.textContent = e.message;
        place(rect);
      });
  }

  function showTrigger(text, rect) {
    const { wrap } = mountUi();
    wrap.innerHTML = `<div class="trigger" title="翻译选中的文字">${ICON_LOGO}</div>`;
    wrap.querySelector(".trigger").addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showBubble(text, rect);
    });
    place(rect);
  }

  const isUi = (t) => !!ui && t === ui.host;

  document.addEventListener("mouseup", (e) => {
    if (S.selectMode === "off" || e.button !== 0 || isUi(e.target)) return;
    setTimeout(() => {
      const text = window.getSelection()?.toString().trim();
      if (!text || text.length > 5000 || !/\p{L}/u.test(text)) return;
      const rect = selectionRect();
      if (!rect) return;
      S.selectMode === "auto" ? showBubble(text, rect) : showTrigger(text, rect);
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (!isUi(e.target)) removeBubble();
  });

  // ---------- 消息 & 设置 ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "setPage") setPage(msg.on);
    if (msg.type === "showTranslation") showBubble(msg.text, selectionRect());
    if (msg.type === "pageState") {
      const visible = [...units].some((u) => u.font instanceof Element && u.font.isConnected);
      sendResponse({ on: pageOn || visible, host: location.hostname });
    }
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
  })().catch(() => {}); // 插件被更新/卸载时，旧网页里的脚本会失去连接，不用报错
})();
