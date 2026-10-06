/* Otto frontend. Plain ES2022, no dependencies, no build step. */
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const app = $("app");

  const state = {
    tab: "chat",
    conversationId: null,
    conversations: [],
    openTabs: [null], // conversation ids; null is a blank "New chat" tab
    activeTab: 0,
    streaming: false,
    settings: null,
    confirmations: new Map(),
    agentState: "idle",
    isWindows: true,
  };

  const ICON = {
    chat:
      '<svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20l1-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" /></svg>',
    close:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>',
    copy:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l5 5L20 6" /></svg>',
    trash:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></svg>',
  };

  /* ---------------------------------------------------------------- utils */

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => {
      switch (c) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  async function api(path, options) {
    const opts = { ...options };
    if (typeof path === "string" && path.startsWith("/api/settings")) {
      opts.cache = "no-store";
      opts.headers = { ...(opts.headers ?? {}), "Cache-Control": "no-cache", Pragma: "no-cache" };
    }
    const res = await fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = new Error((body && body.error) || res.statusText || "Request failed");
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  const post = (path) => api(path, { method: "POST", body: "{}" });

  // Banner shows only when the *current* uncached /api/settings says the key is
  // missing; re-fetching before send is what stops a cached response pinning it on.
  async function refreshKeyBanner() {
    const settings = await api("/api/settings").catch(() => null);
    if (!settings) return null;
    state.settings = settings;
    applyTheme(settings.theme || "system");
    applyPlatform(settings);
    renderApproval();
    const banner = $("noKeyBanner");
    if (banner) banner.hidden = settings.apiKeySet !== false;
    if (settings.agent && settings.agent.state) setStatus(settings.agent.state);
    return settings;
  }

  function showKeyBanner() {
    const banner = $("noKeyBanner");
    if (banner) banner.hidden = false;
  }

  function hideKeyBanner() {
    const banner = $("noKeyBanner");
    if (banner) banner.hidden = true;
  }

  async function selectModel(id) {
    if (!id || (state.settings && state.settings.model === id)) return;
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ key: "model", value: id }) });
    await refreshKeyBanner();
    await loadSettings();
  }

  function renderModelPicker(s) {
    const models = Array.isArray(s.availableModels) && s.availableModels.length
      ? s.availableModels
      : [{ id: s.model || "gemini-flash-latest", label: s.model || "gemini-flash-latest" }];
    const active = models.find((m) => m.id === s.model) || models[0];

    const label = $("modelLabel");
    if (label) label.textContent = active.label || active.id;

    const list = $("modelList");
    if (!list) return;
    list.textContent = "";
    for (const m of models) {
      const row = el("button", "model-row");
      row.type = "button";
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("aria-checked", String(m.id === active.id));
      row.append(el("span", null, m.label || m.id));
      if (m.id === active.id) {
        const tick = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        tick.setAttribute("class", "tick");
        tick.setAttribute("viewBox", "0 0 24 24");
        tick.setAttribute("aria-hidden", "true");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M4 12l5 5L20 6");
        tick.append(path);
        row.append(tick);
      }
      row.addEventListener("click", () => {
        closeMenus();
        selectModel(m.id).catch(() => loadSettings());
      });
      list.append(row);
    }
  }

  /** Reflects the `allowWrites` permission in the composer's approval control. */
  function renderApproval() {
    const on = Boolean(state.settings && state.settings.toggles && state.settings.toggles.allowWrites);
    const label = $("approvalLabel");
    if (label) label.textContent = on ? "Allow writes" : "Ask for approval";
    for (const btn of document.querySelectorAll("#approvalMenu [data-approve]")) {
      btn.setAttribute("role", "menuitemradio");
      btn.setAttribute("aria-checked", String((btn.dataset.approve === "auto") === on));
    }
  }

  function when(ts) {
    const d = new Date(ts);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function setStatus(value) {
    const normalized = value || "idle";
    state.agentState = normalized;
    const pill = $("statusPill");
    pill.textContent = normalized;
    pill.dataset.state = normalized;
    updateDesktopUI();
  }

  function applyPlatform(s) {
    state.isWindows = Boolean(s.windows);
    updateDesktopUI();
  }

  function updateDesktopUI() {
    const banner = $("liveBanner");
    const text = $("liveBannerText");
    if (!banner || !text) return;
    let mode = state.agentState;
    if (!state.isWindows) mode = "offline";
    banner.dataset.state = mode === "running" ? "live" : mode;
    if (mode === "offline") {
      text.textContent = "Desktop control requires Windows — Otto is running on Linux, so there is no live screen here.";
    } else if (mode === "running") {
      text.textContent = "LIVE — agent is controlling your computer";
    } else if (mode === "paused") {
      text.textContent = "PAUSED — you have control. Press Release control to hand it back.";
    } else if (mode === "stopped") {
      text.textContent = "STOPPED — agent halted";
    } else {
      text.textContent = "IDLE — agent is standing by";
    }
    const release = $("releaseBtn");
    if (release) release.hidden = state.agentState !== "paused";
    const controlsOff = !state.isWindows;
    for (const id of ["pauseBtn", "stopBtn", "takeoverBtn"]) {
      const btn = $(id);
      if (btn) btn.disabled = controlsOff;
    }
    if (!state.isWindows) showPlaceholder("Desktop control needs Windows. Otto is running on Linux, so the screen, mouse and keyboard tools are unavailable here. Server tools and chat work normally.");
  }

  /* -------------------------------------------------------------- theming */

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme || "system");
    try {
      localStorage.setItem("otto.theme", theme || "system");
    } catch {
      /* ignore private-mode failures */
    }
  }

  /* ---------------- popup menus ---------------- */

  const POPUPS = [
    { btnId: "brandBtn", menuId: "brandMenu" },
    { btnId: "modelBtn", menuId: "titleMenu" },
    { btnId: "approvalBtn", menuId: "approvalMenu" },
  ];

  function closeMenus(keep) {
    for (const p of POPUPS) {
      const menu = $(p.menuId);
      if (!menu || menu === keep) continue;
      menu.hidden = true;
      const btn = $(p.btnId);
      if (btn) btn.setAttribute("aria-expanded", "false");
    }
  }

  function toggleMenu(btnId, menuId) {
    const menu = $(menuId);
    const willOpen = menu.hidden;
    closeMenus(willOpen ? menu : null);
    menu.hidden = !willOpen;
    $(btnId).setAttribute("aria-expanded", String(willOpen));
  }

  for (const p of POPUPS) {
    const btn = $(p.btnId);
    if (!btn) continue;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu(p.btnId, p.menuId);
    });
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".pop-wrap, .brand-wrap")) closeMenus();
  });

  /* ---------------- sidebar sections ---------------- */

  function showTab(tab) {
    state.tab = tab;
    for (const btn of document.querySelectorAll("#sections [data-go]")) {
      const on = btn.dataset.go === tab;
      btn.classList.toggle("is-active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    }
    const settingsOpen = tab === "settings";
    $("app").classList.toggle("settings-open", settingsOpen);
    $("screen-settings").setAttribute("aria-hidden", String(!settingsOpen));
    $("screen-settings").inert = !settingsOpen;
    for (const name of ["chat", "desktop", "activity", "settings"]) {
      $("screen-" + name).classList.toggle("is-active", name === (settingsOpen ? "chat" : tab));
    }
    closeDrawer();
    if (settingsOpen) showSettingsPanel("general");
    if (tab === "activity") loadActivity();
    if (settingsOpen) {
      loadSettings();
      $("settingsClose").focus();
    }
  }

  function closeSettings() {
    if (state.tab !== "settings") return;
    showTab("chat");
    $("sections").querySelector('[data-go="chat"]').focus();
  }

  $("settingsClose").addEventListener("click", closeSettings);
  $("screen-settings").addEventListener("click", (e) => {
    if (e.target === $("screen-settings") || e.target.classList.contains("settings-backdrop")) closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSettings();
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-go]");
    if (btn) {
      closeMenus();
      showTab(btn.dataset.go);
      return;
    }
    const settingsBtn = e.target.closest("[data-settings-go]");
    if (settingsBtn) showSettingsPanel(settingsBtn.dataset.settingsGo);
  });

  function showSettingsPanel(panel) {
    for (const btn of document.querySelectorAll("[data-settings-go]")) {
      const active = btn.dataset.settingsGo === panel;
      btn.classList.toggle("is-active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    }
    for (const section of document.querySelectorAll("[data-settings-panel]")) {
      const active = section.dataset.settingsPanel === panel;
      section.classList.toggle("is-active", active);
      section.hidden = !active;
    }
  }

  /* ---------------------------------------------------------------- drawer */

  function openDrawer() {
    app.classList.add("drawer-open");
    $("scrim").hidden = false;
    $("menuBtn").setAttribute("aria-expanded", "true");
  }
  function closeDrawer() {
    app.classList.remove("drawer-open");
    $("scrim").hidden = true;
    $("menuBtn").setAttribute("aria-expanded", "false");
  }
  $("menuBtn").addEventListener("click", openDrawer);
  $("drawerClose").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);

  /* ------------------------------------------------------------- sidebar */

  function renderHistory() {
    const nav = $("history");
    nav.textContent = "";
    if (!state.conversations.length) {
      nav.append(el("p", "empty-note", "No chats yet."));
      return;
    }
    nav.append(el("div", "group-label", "Recents"));
    for (const conv of state.conversations) {
      const label = conv.title || "New chat";

      const row = el("div", "conv-row");
      if (conv.id === state.conversationId) row.classList.add("is-active");

      const btn = el("button", "conv", label);
      btn.type = "button";
      btn.addEventListener("click", () => openConversation(conv.id));
      row.append(btn);

      const del = el("button", "conv-del");
      del.type = "button";
      del.title = `Delete "${label}"`;
      del.setAttribute("aria-label", `Delete ${label}`);
      del.innerHTML = ICON.trash;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteConversation(conv);
      });
      row.append(del);

      nav.append(row);
    }
  }

  /** Removes one chat: server row, messages, and any tab showing it. */
  async function deleteConversation(conv) {
    const label = conv.title || "New chat";
    if (!window.confirm(`Delete "${label}"? This removes the chat and all of its messages.`)) return;
    try {
      await api(`/api/conversations/${encodeURIComponent(conv.id)}`, { method: "DELETE" });
    } catch {
      return; // keep the row: the list still mirrors the server
    }
    state.conversations = state.conversations.filter((c) => c.id !== conv.id);
    const open = state.openTabs.indexOf(conv.id);
    if (open !== -1) closeTab(open);
    renderHistory();
    if (!$("searchWrap").hidden) renderSearch($("searchInput").value);
  }

  async function loadConversations() {
    try {
      state.conversations = await api("/api/conversations");
    } catch {
      state.conversations = [];
    }
    pruneTabs();
    renderHistory();
    renderTabs();
    if (!$("searchWrap").hidden) renderSearch($("searchInput").value);
  }

  /* ---------------------------------------------------------------- tabs */

  function tabTitle(id) {
    if (!id) return "New chat";
    const conv = state.conversations.find((c) => c.id === id);
    return (conv && conv.title) || "Chat";
  }

  function saveTabs() {
    try {
      localStorage.setItem("otto.tabs", JSON.stringify(state.openTabs));
    } catch {
      /* ignore private-mode failures */
    }
  }

  function restoreTabs() {
    try {
      const raw = JSON.parse(localStorage.getItem("otto.tabs") || "null");
      if (Array.isArray(raw) && raw.length) {
        const ids = raw.map((v) => (typeof v === "string" ? v : null));
        if (ids.some((v) => v !== null) || ids.length === 1) state.openTabs = ids;
      }
    } catch {
      /* ignore malformed state */
    }
    if (!state.openTabs.length) state.openTabs = [null];
    state.activeTab = 0;
    state.conversationId = state.openTabs[0];
  }

  // Drop tabs whose conversation no longer exists. Only runs once we actually
  // have conversations, so a failed list call never wipes the open tabs.
  function pruneTabs() {
    if (!state.conversations.length) return;
    const known = new Set(state.conversations.map((c) => c.id));
    const kept = state.openTabs.filter((id) => id === null || known.has(id));
    if (!kept.length) kept.push(null);
    if (kept.length === state.openTabs.length) return;
    const activeId = state.openTabs[state.activeTab];
    state.openTabs = kept;
    const idx = kept.indexOf(activeId);
    state.activeTab = idx === -1 ? 0 : idx;
    state.conversationId = kept[state.activeTab];
  }

  function renderTabs() {
    const box = $("tabs");
    box.textContent = "";
    state.openTabs.forEach((id, i) => {
      const tab = el("button", "tab");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(i === state.activeTab));
      if (i === state.activeTab) tab.classList.add("is-active");

      const icon = el("span", "tab-icon-wrap");
      icon.innerHTML = ICON.chat;
      tab.append(icon);

      tab.append(el("span", "tab-title", tabTitle(id)));

      const close = el("span", "tab-close");
      close.setAttribute("role", "button");
      close.setAttribute("aria-label", `Close ${tabTitle(id)}`);
      close.innerHTML = ICON.close;
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(i);
      });
      tab.append(close);

      tab.addEventListener("click", () => switchTab(i));
      box.append(tab);
    });
  }

  let threadToken = 0;

  async function loadThread(id) {
    const token = ++threadToken;
    const thread = $("thread");
    thread.textContent = "";
    if (!id) {
      thread.append(emptyState());
      updateScrollBtn();
      return;
    }
    let rows = [];
    try {
      rows = await api(`/api/conversations/${encodeURIComponent(id)}/messages`);
    } catch {
      rows = [];
    }
    if (token !== threadToken) return;
    if (!rows.length) thread.append(emptyState());
    else for (const row of rows) appendMessage(row.role, row.content);
    thread.scrollTop = thread.scrollHeight;
    updateScrollBtn();
  }

  async function switchTab(i) {
    if (i < 0 || i >= state.openTabs.length) return;
    state.activeTab = i;
    state.conversationId = state.openTabs[i];
    saveTabs();
    renderTabs();
    renderHistory();
    await loadThread(state.conversationId);
  }

  async function openConversation(id) {
    const existing = state.openTabs.indexOf(id);
    if (existing !== -1) await switchTab(existing);
    else {
      state.openTabs.push(id);
      await switchTab(state.openTabs.length - 1);
    }
    closeDrawer();
  }

  function closeTab(i) {
    const wasActive = i === state.activeTab;
    state.openTabs.splice(i, 1);
    if (!state.openTabs.length) {
      state.openTabs = [null];
      state.activeTab = 0;
    } else if (i < state.activeTab) {
      state.activeTab -= 1;
    } else if (wasActive) {
      state.activeTab = Math.min(i, state.openTabs.length - 1);
    }
    state.conversationId = state.openTabs[state.activeTab];
    saveTabs();
    renderTabs();
    renderHistory();
    loadThread(state.conversationId);
  }

  function newChatTab() {
    // Reuse a blank tab rather than stacking identical empty ones.
    const blank = state.openTabs.indexOf(null);
    if (blank !== -1) switchTab(blank);
    else {
      state.openTabs.push(null);
      switchTab(state.openTabs.length - 1);
    }
    $("input").focus();
    closeDrawer();
  }

  $("tabAdd").addEventListener("click", newChatTab);
  $("newChatBtn").addEventListener("click", newChatTab);

  function emptyState() {
    const wrap = el("div", "empty");
    wrap.append(el("div", "wordmark", "Otto"));
    wrap.append(
      el(
        "p",
        "empty-sub",
        "Ask anything. Otto can chat, and drive your computer or server when you allow it.",
      ),
    );
    const chips = el("div", "chips");
    for (const label of [
      "What can you do?",
      "Summarize a file in this folder",
      "Take a screenshot and describe it",
      "Plan a weekend project",
    ]) {
      const chip = el("button", "chip", label);
      chip.type = "button";
      chip.addEventListener("click", () => {
        $("input").value = label;
        autosize();
        send();
      });
      chips.append(chip);
    }
    wrap.append(chips);
    return wrap;
  }

  /* --------------------------------------------------------------- search */

  function openSearch() {
    const wrap = $("searchWrap");
    if (wrap.hidden) {
      wrap.hidden = false;
      $("searchBtn").setAttribute("aria-expanded", "true");
      $("searchInput").value = "";
      renderSearch("");
      if (window.matchMedia("(max-width: 860px)").matches) openDrawer();
      $("searchInput").focus();
    } else {
      wrap.hidden = true;
      $("searchBtn").setAttribute("aria-expanded", "false");
    }
  }

  $("searchBtn").addEventListener("click", openSearch);
  $("railSearchBtn").addEventListener("click", () => {
    if ($("searchWrap").hidden) openSearch();
    else $("searchInput").focus();
  });

  $("searchInput").addEventListener("input", (e) => renderSearch(e.target.value));
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("searchWrap").hidden = true;
      $("searchBtn").setAttribute("aria-expanded", "false");
    }
  });

  function renderSearch(term) {
    const box = $("searchResults");
    box.textContent = "";
    const needle = String(term || "").trim().toLowerCase();
    const hits = needle
      ? state.conversations.filter((c) => (c.title || "").toLowerCase().includes(needle))
      : state.conversations.slice(0, 8);
    if (!hits.length) {
      box.append(el("p", "empty-note", needle ? "No chats match." : "No chats yet."));
      return;
    }
    for (const hit of hits) {
      const row = el("button", "search-row", hit.title || "New chat");
      row.type = "button";
      row.setAttribute("role", "option");
      row.addEventListener("click", () => {
        $("searchWrap").hidden = true;
        $("searchBtn").setAttribute("aria-expanded", "false");
        openConversation(hit.id);
      });
      box.append(row);
    }
  }

  $("profileBtn").addEventListener("click", () => showTab("settings"));

  /* ------------------------------------------------------------ markdown */

  /** Escapes first, then converts a small, predictable Markdown subset. */
  function inline(text) {
    let s = esc(text);
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return "\u0000" + (codes.length - 1) + "\u0001";
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^_\w])__([^_\n]+)__/g, "$1<strong>$2</strong>");
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      if (!/^(https?:|mailto:|#|\/)/i.test(url)) return match;
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    s = s.replace(/\n/g, "<br>");
    s = s.replace(/\u0000(\d+)\u0001/g, (_, n) => `<code>${codes[Number(n)] ?? ""}</code>`);
    return s;
  }

  function codeBlock(lang, code) {
    return (
      `<div class="codeblock"><div class="code-head">` +
      `<span class="code-lang">${esc(lang)}</span>` +
      `<button type="button" class="code-copy" aria-label="Copy code">${ICON.copy}</button>` +
      `</div><pre><code>${esc(code)}</code></pre></div>`
    );
  }

  function renderMarkdown(src) {
    const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let para = [];
    let list = null;
    let quote = [];

    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join("\n"))}</p>`);
      para = [];
    };
    const flushList = () => {
      if (!list) return;
      out.push(`<${list.tag}>${list.items.map((t) => `<li>${t}</li>`).join("")}</${list.tag}>`);
      list = null;
    };
    const flushQuote = () => {
      if (quote.length) out.push(`<blockquote>${inline(quote.join("\n"))}</blockquote>`);
      quote = [];
    };
    const flushAll = () => {
      flushPara();
      flushList();
      flushQuote();
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;

      if ((m = line.match(/^\s*```([\w+-]*)\s*$/))) {
        flushAll();
        const lang = m[1] || "code";
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        out.push(codeBlock(lang, buf.join("\n")));
        continue;
      }
      if (!line.trim()) {
        flushAll();
        continue;
      }
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        flushAll();
        const level = m[1].length;
        out.push(`<h${level}>${inline(m[2])}</h${level}>`);
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushAll();
        out.push("<hr>");
        continue;
      }
      if ((m = line.match(/^\s*>\s?(.*)$/))) {
        flushPara();
        flushList();
        quote.push(m[1]);
        continue;
      }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara();
        flushQuote();
        if (!list || list.tag !== "ul") {
          flushList();
          list = { tag: "ul", items: [] };
        }
        list.items.push(inline(m[1]));
        continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        flushQuote();
        if (!list || list.tag !== "ol") {
          flushList();
          list = { tag: "ol", items: [] };
        }
        list.items.push(inline(m[1]));
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += " " + inline(line.trim());
        continue;
      }
      flushList();
      flushQuote();
      para.push(line);
    }
    flushAll();
    return out.join("");
  }

  /* ----------------------------------------------------------------- chat */

  function appendMessage(role, text) {
    const thread = $("thread");
    const welcome = thread.querySelector(".empty");
    if (welcome) welcome.remove();

    const wrap = el("div", `msg ${role === "user" ? "user" : "assistant"}`);
    const body = el("div", "body");
    const content = el("div", role === "user" ? "bubble" : "content");
    if (role === "user") content.textContent = String(text ?? "");
    else content.innerHTML = renderMarkdown(text ?? "");
    body.append(content);
    wrap.append(body);
    thread.append(wrap);
    thread.scrollTop = thread.scrollHeight;
    updateScrollBtn();
    return content;
  }

  function setCursor(node, on) {
    node.classList.remove("cursor");
    const previous = node.querySelector(".cursor");
    if (previous) previous.classList.remove("cursor");
    if (!on) return;
    (node.lastElementChild || node).classList.add("cursor");
  }

  function nearBottom() {
    const thread = $("thread");
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
  }

  function scrollToEnd(smooth) {
    const thread = $("thread");
    thread.scrollTo({ top: thread.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    updateScrollBtn();
  }

  function updateScrollBtn() {
    const thread = $("thread");
    const btn = $("scrollDown");
    if (!thread || !btn) return;
    btn.hidden = thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 140;
  }

  $("thread").addEventListener("scroll", updateScrollBtn);
  $("scrollDown").addEventListener("click", () => scrollToEnd(true));

  $("thread").addEventListener("click", async (e) => {
    const btn = e.target.closest(".code-copy");
    if (!btn) return;
    const block = btn.closest(".codeblock");
    const code = block && block.querySelector("pre");
    if (!code) return;
    const text = code.textContent;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.append(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      btn.classList.add("is-done");
      btn.innerHTML = ICON.check;
      window.setTimeout(() => {
        btn.classList.remove("is-done");
        btn.innerHTML = ICON.copy;
      }, 1400);
    } catch {
      /* clipboard denied — leave the button untouched */
    }
  });

  const input = $("input");
  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }

  // The reference UI greys the send button out whenever there is nothing to send.
  function updateSendState() {
    const btn = $("sendBtn");
    if (btn) btn.disabled = state.streaming || !input.value.trim();
  }

  input.addEventListener("input", () => {
    autosize();
    updateSendState();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  $("chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    input.value = chip.textContent;
    autosize();
    send();
  });

  $("attachBtn").addEventListener("click", () => {
    window.alert("Attach a file by asking Otto to read it, for example: \"read notes.md\".");
  });
  $("micBtn").addEventListener("click", () => {
    window.alert("Dictation is not available in this build. Type your message instead.");
  });

  $("noKeyAction").addEventListener("click", () => showTab("settings"));

  $("approvalMenu").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-approve]");
    if (!btn) return;
    closeMenus();
    const want = btn.dataset.approve === "auto";
    const current = Boolean(state.settings && state.settings.toggles && state.settings.toggles.allowWrites);
    if (want === current) return;
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ key: "allowWrites", value: want }),
      });
      await loadSettings();
    } catch {
      renderApproval();
    }
  });

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });

  async function send() {
    const message = input.value.trim();
    if (!message || state.streaming) return;

    input.value = "";
    autosize();
    appendMessage("user", message);
    state.streaming = true;
    setStatus("running");
    updateSendState();

    const live = appendMessage("assistant", "");
    setCursor(live, true);
    let text = "";
    const paint = () => {
      const stick = nearBottom();
      live.innerHTML = renderMarkdown(text);
      setCursor(live, true);
      if (stick) scrollToEnd();
      else updateScrollBtn();
    };

    const settings = await refreshKeyBanner();
    if (settings && settings.apiKeySet === false) {
      live.textContent = "API key not set. Add your Google API key in Settings.";
      setCursor(live, false);
      state.streaming = false;
      setStatus("idle");
      updateSendState();
      showKeyBanner();
      return;
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversationId: state.conversationId }),
      });

      if (!res.ok) {
        let payload = null;
        try {
          payload = await res.json();
        } catch {
          payload = null;
        }
        if (res.status === 503 || (payload && payload.code === "KEY_MISSING")) {
          showKeyBanner();
          live.textContent = "API key not set. Add your Google API key in Settings.";
          return;
        }
        throw new Error((payload && payload.error) || res.statusText);
      }

      hideKeyBanner();

      for await (const evt of readSse(res)) {
        if (evt.event === "start" && evt.data && evt.data.conversationId) {
          state.conversationId = evt.data.conversationId;
          state.openTabs[state.activeTab] = evt.data.conversationId;
          saveTabs();
          renderTabs();
          loadConversations();
        } else if (evt.event === "delta" && evt.data && evt.data.text) {
          text += evt.data.text;
          paint();
        } else if (evt.event === "done") {
          if (evt.data && typeof evt.data.text === "string" && evt.data.text) text = evt.data.text;
          paint();
          if (evt.data && evt.data.status) setStatus(evt.data.status === "running" ? "running" : "idle");
        } else if (evt.event === "error") {
          text = (evt.data && evt.data.error) || "Otto hit an error.";
          paint();
          if (evt.data && evt.data.code === "KEY_MISSING") showKeyBanner();
        }
      }

      if (!text) {
        text = "Otto finished without a reply. Try asking again.";
        paint();
      }
    } catch (err) {
      text = `Otto could not finish that: ${err.message}`;
      paint();
    } finally {
      setCursor(live, false);
      state.streaming = false;
      setStatus("idle");
      updateSendState();
      loadConversations();
    }
  }

  /** Parse a fetch() response body as Server-Sent Events. */
  async function* readSse(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut = buf.indexOf("\n\n");
      while (cut !== -1) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const evt = { event: "message", data: null };
        const dataLines = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) evt.event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length) {
          try {
            evt.data = JSON.parse(dataLines.join("\n"));
          } catch {
            evt.data = null;
          }
        }
        yield evt;
        cut = buf.indexOf("\n\n");
      }
    }
  }

  /* --------------------------------------------------------------- desktop */

  function logStep(text, tool) {
    const log = $("stepLog");
    const row = el("li", null, tool ? `${text}  ·  ${tool}` : text);
    log.append(row);
    while (log.childElementCount > 200) log.removeChild(log.firstElementChild);
    log.scrollTop = log.scrollHeight;
    $("currentAction").textContent = text;
  }

  function showFrame(png) {
    $("screenImg").src = `data:image/png;base64,${png}`;
    $("screenImg").hidden = false;
    $("screenPlaceholder").hidden = true;
  }

  function showPlaceholder(reason) {
    $("screenImg").hidden = true;
    $("screenPlaceholder").hidden = false;
    $("screenPlaceholder").querySelector(".ph-text").textContent = reason;
  }

  $("pauseBtn").addEventListener("click", () => post("/api/desktop/pause").catch(() => {}));
  $("stopBtn").addEventListener("click", () => post("/api/desktop/stop").catch(() => {}));
  $("takeoverBtn").addEventListener("click", () => post("/api/desktop/takeover").catch(() => {}));
  $("releaseBtn").addEventListener("click", () => post("/api/desktop/release").catch(() => {}));

  let socket = null;
  let retry = 1000;

  function connect() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${proto}//${window.location.host}/ws/desktop`);

    socket.addEventListener("open", () => {
      retry = 1000;
      $("reconnectNote").hidden = true;
    });

    socket.addEventListener("message", (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "frame":
          showFrame(msg.png);
          break;
        case "placeholder":
          showPlaceholder(msg.reason || "No live screen available.");
          break;
        case "step":
          logStep(msg.text || "step", msg.tool);
          break;
        case "status":
          setStatus(msg.state);
          if (msg.detail) $("currentAction").textContent = msg.detail;
          break;
        case "confirm":
          askConfirm(msg);
          break;
        case "confirm_result":
          settleConfirm(msg.id, msg);
          break;
        default:
          break;
      }
    });

    socket.addEventListener("close", () => {
      $("reconnectNote").hidden = false;
      window.setTimeout(connect, retry);
      retry = Math.min(retry * 2, 15000);
    });

    socket.addEventListener("error", () => socket.close());
  }

  function askConfirm(msg) {
    const card = el("div", "card");
    card.append(el("div", "section-label", `Confirm: ${msg.tool}`));
    card.append(el("p", "note", msg.detail || "Otto wants to run a sensitive action."));
    const row = el("div", "row-between");
    const yes = el("button", "btn primary", "Approve");
    const no = el("button", "btn danger", "Deny");
    yes.type = no.type = "button";
    row.append(yes, no);
    card.append(row);
    $("thread").append(card);
    $("thread").scrollTop = $("thread").scrollHeight;
    updateScrollBtn();
    state.confirmations.set(msg.id, card);
    yes.addEventListener("click", () => answer(msg.id, true));
    no.addEventListener("click", () => answer(msg.id, false));
  }

  async function answer(id, approved) {
    const card = state.confirmations.get(id);
    if (card) {
      card.replaceChildren(el("p", "note", approved ? "Approved." : "Denied."));
      state.confirmations.delete(id);
    }
    try {
      await api("/api/desktop/confirm", {
        method: "POST",
        body: JSON.stringify({ id, approved }),
      });
    } catch {
      /* the socket confirm_result broadcast settles the UI anyway */
    }
    if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: "confirm", id, approved }));
  }

  function settleConfirm(id, msg) {
    const card = state.confirmations.get(id);
    if (!card) return;
    card.replaceChildren(el("p", "note", msg.approved ? "Approved." : msg.reason || "Denied."));
    state.confirmations.delete(id);
  }

  /* -------------------------------------------------------------- activity */

  async function loadActivity() {
    const box = $("activityRows");
    box.textContent = "";
    let rows = [];
    try {
      rows = await api("/api/activity");
    } catch {
      rows = [];
    }
    if (!rows.length) {
      box.append(el("p", "empty-note", "Nothing here yet. Ask Otto to do something."));
      return;
    }
    for (const row of rows) {
      const card = el("div", "act-row");
      const head = el("div", "act-head");
      head.append(el("div", "act-title", row.title || "Task"));

      const meta = el("div", "act-meta");
      const steps = Array.isArray(row.steps) ? row.steps : [];
      meta.append(el("span", "pill", `${steps.length} step${steps.length === 1 ? "" : "s"}`));
      meta.append(el("span", "pill", row.kind || "chat"));
      const status = el("span", "pill", row.status || "done");
      status.dataset.status = row.status || "done";
      meta.append(status);
      head.append(meta);

      const sub = el("div", "act-sub", when(row.created_at));
      head.append(sub);

      const detail = el("div", "act-detail");
      detail.hidden = true;
      detail.textContent = steps.length
        ? steps.map((s) => `${when(s.at)}${s.tool ? ` ${s.tool}` : ""} — ${s.text}`).join("\n")
        : "No steps recorded.";

      head.addEventListener("click", () => {
        detail.hidden = !detail.hidden;
      });

      card.append(head, detail);
      box.append(card);
    }
  }

  /* -------------------------------------------------------------- settings */

  const TOGGLE_DEFS = {
    mouse: { label: "Mouse", desc: "Move and click with the mouse.", group: "win" },
    keyboard: { label: "Keyboard", desc: "Type text and press key combos.", group: "win" },
    screen: { label: "Screen viewing", desc: "Stream the live screen to the Desktop tab.", group: "win" },
    openApps: { label: "Open apps", desc: "Launch applications by name.", group: "win" },
    fileAccess: { label: "File access", desc: "Read, list and write files in the workspace.", group: "server" },
    shell: { label: "Shell", desc: "Run commands. Each command still asks first.", group: "server" },
    allowWrites: {
      label: "Writes without asking",
      desc: "Off means every file write asks for confirmation.",
      group: "server",
    },
  };

  function buildToggles(container, keys) {
    const box = $(container);
    box.textContent = "";
    for (const key of keys) {
      const def = TOGGLE_DEFS[key];
      const row = el("div", "toggle");
      const text = el("div");
      text.append(el("span", "t-label", def.label));
      text.append(el("span", "t-desc", def.desc));
      const sw = el("button", "switch");
      sw.type = "button";
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", "false");
      sw.setAttribute("aria-label", def.label);
      sw.dataset.key = key;
      sw.addEventListener("click", async () => {
        const next = sw.getAttribute("aria-checked") !== "true";
        sw.setAttribute("aria-checked", String(next));
        try {
          await api("/api/settings", {
            method: "PUT",
            body: JSON.stringify({ key, value: next }),
          });
          if (key === "allowWrites") {
            if (!state.settings) state.settings = {};
            if (!state.settings.toggles) state.settings.toggles = {};
            state.settings.toggles.allowWrites = next;
            renderApproval();
          }
        } catch {
          sw.setAttribute("aria-checked", String(!next));
        }
      });
      row.append(text, sw);
      box.append(row);
    }
  }

  async function loadSettings() {
    let s;
    try {
      s = await api("/api/settings");
    } catch {
      return;
    }
    state.settings = s;

    applyPlatform(s);
    renderApproval();

    const modelSelect = $("modelInput");
    const models = Array.isArray(s.availableModels) && s.availableModels.length
      ? s.availableModels
      : [{ id: s.model || "gemini-flash-latest", label: s.model || "gemini-flash-latest" }];
    modelSelect.textContent = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      modelSelect.append(opt);
    }
    modelSelect.value = s.model || models[0].id;
    renderModelPicker(s);
    $("themeSelect").value = s.theme || "system";
    $("langSelect").value = s.language || "en";

    for (const sw of document.querySelectorAll(".switch")) {
      sw.setAttribute("aria-checked", String(Boolean(s.toggles && s.toggles[sw.dataset.key])));
    }

    $("keyInput").value = "";
    $("clearKeyBtn").hidden = s.apiKeySource !== "settings";
    $("keyNote").textContent = s.apiKeySource === "settings"
      ? "A key is saved locally. Enter a new key to replace it; the saved key is never sent to the browser."
      : s.apiKeySource === "environment"
        ? "A key is loaded from Otto's environment. Saving here will store a Settings key that takes precedence."
        : "No key configured. Paste your Google AI Studio key and save.";

    const mcp = $("mcpRows");
    mcp.textContent = "";
    const servers = Array.isArray(s.mcpServers) ? s.mcpServers : [];
    if (!servers.length) {
      mcp.append(el("p", "empty-note", "No MCP servers configured. Add one to mcp.json to see it here."));
    } else {
      for (const server of servers) {
        const card = el("div", "act-row");
        const head = el("div", "act-head");
        const title = el("div", "act-title", server.name);
        head.append(title);
        const sw = el("button", "switch");
        sw.type = "button";
        sw.setAttribute("role", "switch");
        sw.setAttribute("aria-checked", String(Boolean(server.enabled)));
        sw.setAttribute("aria-label", `Enable ${server.name}`);
        sw.addEventListener("click", async () => {
          const next = sw.getAttribute("aria-checked") !== "true";
          sw.setAttribute("aria-checked", String(next));
          try {
            await api("/api/settings", {
              method: "PUT",
              body: JSON.stringify({ key: `mcp:${server.name}`, value: next }),
            });
          } catch {
            sw.setAttribute("aria-checked", String(!next));
          }
        });
        head.append(sw);
        if (server.command) {
          head.append(el("div", "act-sub", `${server.command} ${(server.args || []).join(" ")}`.trim()));
        }
        card.append(head);
        mcp.append(card);
      }
    }
  }

  $("themeSelect").addEventListener("change", (e) => {
    applyTheme(e.target.value);
    api("/api/settings", { method: "PUT", body: JSON.stringify({ key: "theme", value: e.target.value }) }).catch(
      () => {},
    );
  });

  $("langSelect").addEventListener("change", (e) => {
    api("/api/settings", { method: "PUT", body: JSON.stringify({ key: "language", value: e.target.value }) }).catch(
      () => {},
    );
  });

  $("modelInput").addEventListener("change", (e) => {
    const previous = state.settings && state.settings.model;
    selectModel(e.target.value).catch(() => {
      e.target.value = previous || e.target.value;
    });
  });

  async function updateApiKey(value) {
    const note = $("keyNote");
    const saveButton = $("saveKeyBtn");
    const clearButton = $("clearKeyBtn");
    saveButton.disabled = true;
    clearButton.disabled = true;
    note.textContent = "Saving key…";
    try {
      const result = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ key: "googleApiKey", value }),
      });
      $("keyInput").value = "";
      clearButton.hidden = result.apiKeySource !== "settings";
      note.textContent = result.apiKeySource === "settings"
        ? "Key saved locally. Otto is ready to use it; the key is never sent back to the browser."
        : result.apiKeySource === "environment"
          ? "Saved key removed. Otto is still using the environment key."
          : "Saved key removed. Add a key to use Chat.";
      await refreshKeyBanner();
    } catch (err) {
      note.textContent = err.message || "Could not save the API key.";
    } finally {
      saveButton.disabled = false;
      clearButton.disabled = false;
    }
  }

  $("saveKeyBtn").addEventListener("click", () => {
    const value = $("keyInput").value.trim();
    if (!value) {
      $("keyNote").textContent = "Paste a Google API key first.";
      $("keyInput").focus();
      return;
    }
    void updateApiKey(value);
  });

  $("clearKeyBtn").addEventListener("click", () => {
    if (!window.confirm("Remove Otto's saved API key? An environment key, if configured, will still be used.")) return;
    void updateApiKey("");
  });

  $("dangerStop").addEventListener("click", () => {
    post("/api/desktop/stop").catch(() => {});
    setStatus("stopped");
  });

  $("eraseBtn").addEventListener("click", async () => {
    if (!window.confirm("Erase all memory? Every conversation, message and memory entry is deleted.")) return;
    try {
      await api("/api/memory/erase", { method: "POST", body: "{}" });
      state.openTabs = [null];
      state.activeTab = 0;
      state.conversationId = null;
      saveTabs();
      renderTabs();
      const thread = $("thread");
      thread.textContent = "";
      thread.append(emptyState());
      renderHistory();
      loadConversations();
      loadActivity();
    } catch {
      /* ignore */
    }
  });

  /* ------------------------------------------------------------------ boot */

  buildToggles("winToggles", ["mouse", "keyboard", "screen", "openApps"]);
  buildToggles("serverToggles", ["fileAccess", "shell", "allowWrites"]);

  restoreTabs();
  renderTabs();
  autosize();
  updateSendState();

  refreshKeyBanner().then((s) => {
    if (s) state.settings = s;
  });

  loadConversations().then(() => switchTab(state.activeTab));
  loadSettings();
  connect();
})();
