(function () {
  "use strict";

  var doc = document;
  var url = new URL(window.location.href);
  var language = url.searchParams.get("lang") === "zh" ? "zh" : "en";
  var copy = {
    "Workflow": "工作流程",
    "Modes": "协作模式",
    "Capabilities": "核心能力",
    "In a run": "运行实例",
    "How it differs": "产品差异",
    "FAQ": "常见问题",
    "Download V1.0.4": "下载 V1.0.4",
    "LOCAL-FIRST · MULTI-AGENT WORK CELL": "本地优先 · 多 Agent 协作空间",
    "Multi-Agent Work,": "多 Agent 协作，",
    "Legible & Accountable": "过程清晰，责任可循",
    "Meldwork builds the": "Meldwork 为 AI Agent 构建",
    "organization layer": "协作组织层",
    "for AI agents — a local work cell that keeps participants explicit, context scoped, run state inspectable, and human review in the loop.": "：在本地工作空间中明确参与者、限定上下文、查看运行状态，并由你参与审核。",
    "Download for macOS": "下载 macOS 版",
    "V1.0.4 · Apple silicon": "V1.0.4 · Apple 芯片",
    "View on GitHub": "在 GitHub 查看",
    "One task — across the Agent CLIs you already run.": "一个任务，连接你已经在用的 Agent CLI。",
    "Supported Agent CLIs": "支持的 Agent CLI",
    "Collaboration Modes": "协作模式",
    "Local-first work cell": "本地优先的协作空间",
    "Human adoption gate": "人工确认采纳",
    "DETECTED ON YOUR MACHINE": "发现本机 AGENT",
    "Works with the agents you already run.": "连接你已经在用的 Agent。",
    "Meldwork detects an installed command when its adapter and the CLI version are compatible. Approved Agent Connectors can be added through the Agent Connector SDK.": "适配器与 CLI 版本兼容时，Meldwork 可检测本机已安装的命令行工具。也可通过 Agent Connector SDK 添加获准使用的连接器。",
    "THE SHORT ANSWER": "关于 MELDWORK",
    "What is Meldwork?": "Meldwork 是什么？",
    "Meldwork is a": "Meldwork 是一个",
    "local-first work cell for AI coding agents": "本地优先的 AI 编程 Agent 协作空间",
    "— it orchestrates the agent CLIs you already run around one frozen task snapshot, records every finding as evidence, and puts a": "，围绕同一份冻结的任务快照组织你已有的 Agent CLI，保留发现与证据，并在工作区发生变更前设置",
    "human adoption gate": "人工采纳确认",
    "before any workspace change.": "。",
    "Supported agents": "支持的 Agent",
    "Codex, Claude Code, Gemini CLI, Qwen Code, Kimi Code, MiMo Code, OpenCode, OpenCodeReview, Hermes, Pi Agent, OpenClaw, WorkBuddy — detected natively on your machine.": "Codex、Claude Code、Gemini CLI、Qwen Code、Kimi Code、MiMo Code、OpenCode、OpenCodeReview、Hermes、Pi Agent、OpenClaw、WorkBuddy，直接检测本机安装。",
    "Direct · Concurrent Responses · Auto Discussion V4": "直接会话 · 并发回复 · 自动讨论 V4",
    "Review record": "复核记录",
    "Finding": "发现",
    "Evidence": "证据",
    "Decision": "决策",
    "Disposition": "处置",
    "Attached to every result — dissent stays visible, never hidden behind a manager.": "每个结果都关联记录，保留不同意见，不让汇总掩盖分歧。",
    "Runs on": "运行平台",
    "macOS · Apple silicon · Electron": "macOS · Apple 芯片 · Electron",
    "100% local-first work cell": "100% 本地优先的协作空间",
    "THE WORK CELL": "从任务到结果",
    "Four steps from task to adopted result.": "四步完成任务，确认采纳结果。",
    "Select": "选择参与者",
    "Choose the local Agents and participants. Participants are always selected by you — never auto-assigned from a roster.": "选择本地 Agent 与参与者。由你决定谁参与，不从名单中自动分配。",
    "Scope": "限定范围",
    "Bound the goal, working directory, context, and permissions. Every run starts from a frozen task snapshot.": "明确目标、工作目录、上下文和权限。每次运行都从冻结的任务快照开始。",
    "Run": "开始协作",
    "Direct, Concurrent Responses, or Auto Discussion V4 — from a single focused session to negotiated multi-round work.": "选择直接会话、并发回复或自动讨论 V4，从单个 Agent 的专注工作到多轮协商。",
    "Review & adopt": "复核与采纳",
    "Inspect findings, evidence, and any Human Gate before the workspace changes. Nothing writes itself.": "工作区变更前，查看发现、证据与人工审批请求。写入由你确认。",
    "COLLABORATION MODES": "协作模式",
    "Three ways agents work together.": "三种模式，匹配不同协作深度。",
    "Same Case, same evidence trail — different depth of agreement. Pick the mode that matches how much review the decision deserves.": "同一个任务、同一条证据链，可以有不同深度的讨论。根据决策需要的复核程度选择模式。",
    "Direct": "直接会话",
    "One selected Agent keeps its conversation and native session when supported.": "与一个选定的 Agent 对话，支持时延续其原生会话。",
    "Best for focused work with one Agent.": "适合与单个 Agent 专注完成任务。",
    "Concurrent Responses": "并发回复",
    "Selected Agents receive the same frozen task snapshot and return independent replies in stable order.": "所选 Agent 接收同一份冻结任务快照，独立回复，并按固定顺序呈现。",
    "Best for comparing approaches before choosing one.": "适合先比较不同方案，再做选择。",
    "Auto Discussion V4": "自动讨论 V4",
    "Agents propose, challenge, negotiate responsibilities, execute dependency-aware work, then verify the result.": "Agent 提出方案、相互质询、协商分工，按依赖关系执行，再验证结果。",
    "Best for multi-round work with explicit responsibility.": "适合分工明确、需要多轮讨论的任务。",
    "WHAT YOU CONTROL": "协作由你掌控",
    "Four guarantees that hold the work together.": "四项核心保障，让协作有据可查。",
    "These four invariants are what make multi-agent output reviewable instead of just decorative.": "从权限到证据，为多 Agent 的每次输出保留可复核的依据。",
    "Human Gate": "人工审批",
    "Workspace writes are opt-in. Nothing changes until": "工作区写入需主动启用，由",
    "you": "你",
    "adopt the result — agents don't.": "采纳结果后再变更，不由 Agent 自行决定。",
    "Opt-in workflow controls": "主动授权的工作流控制",
    "Frozen Context": "冻结上下文",
    "Every run starts from a snapshot. All selected Agents see the same brief, in stable order.": "每次运行从快照开始。所选 Agent 获得同一份任务说明，顺序保持一致。",
    "Case-scoped, reproducible": "任务范围明确，可复现",
    "Evidence Trail": "证据链",
    "Finding → Evidence → Decision → Disposition, attached to each result. Dissent stays visible.": "发现 → 证据 → 决策 → 处置，与每个结果关联，不同意见始终可见。",
    "No hidden manager": "不让汇总掩盖分歧",
    "Local-first Boundary": "本地优先的边界",
    "Electron work cell on your machine. No remote Agent fleet. Conversations stay local.": "Electron 工作空间运行在你的电脑上。没有远程 Agent 集群，会话保存在本地。",
    "Your CLI, your data": "你的 CLI，你的数据",
    "INSIDE THE WORK CELL": "走进工作空间",
    "Inspectable from discovery to adoption.": "从发现 Agent 到采纳结果，全程可查。",
    "Local Agent discovery": "发现本地 Agent",
    "Pick the participants before any work runs. Meldwork detects installed CLIs and shows their adapter status.": "运行前选择参与者。Meldwork 检测已安装的 CLI，并显示适配器状态。",
    "Multi-agent review": "多 Agent 复核",
    "Findings, evidence, and adoption decisions live in one Case. Dissent stays visible — never hidden behind a manager.": "发现、证据与采纳决策归入同一个任务。保留不同意见，不让汇总掩盖分歧。",
    "Propose, negotiate, verify — across rounds. Every Agent's position is preserved for later review.": "跨轮次提出方案、协商、验证。每个 Agent 的立场都被保留，供后续复核。",
    "Direct mode": "直接会话",
    "One Agent, its native session preserved. Focused work with the full evidence trail still attached.": "一个 Agent，延续原生会话。专注处理任务，同时保留完整证据链。",
    "Example: give Codex, Claude Code, and Gemini CLI the same change-review context, compare their independent findings, then adopt only the evidence-backed result you approve.": "例如：将同一份变更复核上下文交给 Codex、Claude Code 和 Gemini CLI，比较各自的独立发现，只采纳你认可且有证据支持的结果。",
    "HOW MELDWORK DIFFERS": "MELDWORK 的不同",
    "An organization layer, not another runner.": "组织协作，不止运行命令。",
    "Meldwork connects the local Agent tools you already use to a decision-ready review workflow — and keeps independent findings, evidence, responsibility, and the human adoption decision visible in one local work cell.": "Meldwork 将你已有的本地 Agent 工具接入面向决策的复核流程，在同一工作空间中保留独立发现、证据、责任与人工采纳决策。",
    "Finding → Evidence → Decision → Disposition": "发现 → 证据 → 决策 → 处置",
    "Dissent stays visible. Disagreement, re-checks, and adoption records are tracked — never hidden behind a central manager.": "不同意见始终可见。分歧、复查与采纳都有记录，不被统一汇总掩盖。",
    "Human Gate before workspace writes": "写入工作区前，由人确认",
    "Workspace writes are opt-in workflow controls. You adopt the result — the agents don't.": "工作区写入由你主动授权。是否采纳结果，由你决定，不由 Agent 代替。",
    "Local-first boundaries": "本地优先，边界明确",
    "Runs in your Electron work cell with existing CLIs. No cloud Agent fleet, no required server, conversations stay local.": "在本地 Electron 工作空间中调用已有 CLI。没有云端 Agent 集群，无需必备服务器，会话保存在本地。",
    "Frozen context, independent judgment": "冻结上下文，独立做判断",
    "Case-scoped independent judgments with evidence-backed decisions — not terminal count or worktree throughput.": "围绕任务形成独立判断，以证据支持决策，而不是追求终端数量或工作树吞吐量。",
    "WHERE MELDWORK FITS": "产品定位",
    "The categories you usually compare against.": "与常见 Agent 工具有什么不同？",
    "A condensed map of how Meldwork positions itself next to terminal runners, cloud fleets, communication networks, and framework-based orchestrators. Full per-project comparison lives in the": "将 Meldwork 与终端运行器、云端集群、通信网络和编排框架放在一起比较。具体项目的完整对比见",
    "README ↗": "项目说明 ↗",
    "Category": "工具类别",
    "What it focuses on": "主要关注",
    "Meldwork's difference": "Meldwork 的侧重",
    "Terminal / IDE runners": "终端 / IDE 运行器",
    "Run a command, view output, navigate worktrees.": "运行命令、查看输出、切换工作树。",
    "Adds evidence-backed review and a human adoption gate on top of the same CLIs.": "在相同 CLI 之上，加入证据驱动的复核与人工采纳确认。",
    "Cloud Agent fleets": "云端 Agent 集群",
    "Hosted sandboxes, remote execution, multi-tenant routing.": "托管沙箱、远程执行、多租户路由。",
    "Local Electron work cell using the CLIs already installed on your machine.": "本地 Electron 工作空间，使用电脑上已安装的 CLI。",
    "Agent communication networks": "Agent 通信网络",
    "Identity, channels, events, persistent collaboration.": "身份、频道、事件与持久协作。",
    "Case-scoped independent judgments, each attached to evidence and a Decision / Disposition.": "任务范围内的独立判断，每项都关联证据、决策与处置记录。",
    "Parallel coding workspaces": "并行编码工作空间",
    "Multiple worktrees, parallel coding Agents, merge queues.": "多工作树、并行编码 Agent、合并队列。",
    "Review across heterogeneous CLIs — not worktree throughput.": "跨不同 CLI 复核，而非追求工作树吞吐量。",
    "Multi-Agent frameworks": "多 Agent 框架",
    "Graphs, routing, approvals, and DSLs you build yourself.": "自行构建执行图、路由、审批和领域语言。",
    "A ready-to-use review workflow — no orchestration framework to assemble.": "开箱即用的复核流程，无需自行组装编排框架。",
    "LEGIBLE": "清晰",
    "ACCOUNTABLE": "可追溯",
    "REUSABLE": "可复用",
    "Meldwork home": "Meldwork 首页",
    "Primary": "主导航",
    "Mobile": "移动端导航",
    "Toggle theme": "切换明暗主题",
    "Menu": "菜单",
    "Scroll to workflow": "查看工作流程",
    "Playback mode": "播放模式",
    "Previous step": "上一步",
    "Next step": "下一步",
    "Pause background animation": "暂停背景动画",
    "Resume background animation": "继续背景动画",
    "Meldwork detecting local Agent CLIs": "Meldwork 检测本地 Agent CLI",
    "Multi-agent review with evidence and human review": "包含证据与人工审核的多 Agent 复核",
    "Auto Discussion V4 group collaboration": "自动讨论 V4 群组协作",
    "Direct multimodal session with local files": "使用本地文件的多模态直接会话",
    "Meldwork · The organization layer for AI agents": "Meldwork · AI Agent 的协作组织层",
    "Meldwork is a local-first work cell for AI coding agents — orchestrate Codex, Claude Code, Gemini CLI and 9 more agent CLIs around one frozen task snapshot, with evidence trails and a human adoption gate before any workspace change.": "Meldwork 是本地优先的 AI 编程 Agent 协作空间。围绕同一份冻结任务快照组织 Codex、Claude Code、Gemini CLI 等 12 个 Agent CLI，保留证据链，并在工作区变更前由人确认采纳。",
    "A local-first work cell for AI coding agents. Orchestrate the agent CLIs you already run, keep every finding as evidence, and gate workspace writes behind human adoption.": "本地优先的 AI 编程 Agent 协作空间。连接你已有的 Agent CLI，保留发现与证据，工作区写入由人确认采纳。",
    "Meldwork is a local-first work cell for AI coding agents. It orchestrates agent CLIs such as Codex, Claude Code, and Gemini CLI around one frozen task snapshot, records every finding as evidence, and puts a human adoption gate before any workspace change.": "Meldwork 是本地优先的 AI 编程 Agent 协作空间。围绕同一份冻结任务快照组织 Codex、Claude Code、Gemini CLI 等工具，记录发现与证据，并在工作区变更前设置人工采纳确认。",
    "Local Agent discovery, Multi-agent review, Auto Discussion V4, Direct mode, Human Gate, Evidence Trail, Frozen Context": "发现本地 Agent、多 Agent 复核、自动讨论 V4、直接会话、人工审批、证据链、冻结上下文"
  };

  function normalize(value) {
    return value.trim().replace(/\s+/g, " ");
  }

  function t(english) {
    var key = normalize(english);
    return language === "zh" && Object.prototype.hasOwnProperty.call(copy, key) ? copy[key] : english;
  }

  var bilingual = Array.from(doc.querySelectorAll("[data-en][data-zh]"));
  bilingual.forEach(function (element) { copy[normalize(element.dataset.en)] = element.dataset.zh; });
  var texts = [];
  var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  var node;
  while ((node = walker.nextNode())) {
    if (node.parentElement.closest("script, style, [data-zh], #localeToggle, [data-split]")) continue;
    texts.push({ node: node, english: node.nodeValue });
  }
  var splitLines = Array.from(doc.querySelectorAll(".hl-line, [data-split-line]"), function (element) {
    return { element: element, english: element.textContent };
  });
  var attributes = [];
  doc.querySelectorAll("[aria-label], [alt], [data-text]").forEach(function (element) {
    ["aria-label", "alt", "data-text"].forEach(function (name) {
      if (element.hasAttribute(name)) attributes.push({ element: element, name: name, english: element.getAttribute(name) });
    });
  });
  var title = doc.title;
  var metadata = Array.from(doc.querySelectorAll('meta[name="description"], meta[property="og:title"], meta[property="og:description"]'),
    function (element) { return { element: element, english: element.content }; });
  var schemas = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'),
    function (element) { return { element: element, english: element.textContent }; });
  var toggle = doc.getElementById("localeToggle");

  function applyLanguage(next) {
    language = next;
    window.MeldworkLocale.language = language;
    doc.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    bilingual.forEach(function (element) { element.textContent = language === "zh" ? element.dataset.zh : element.dataset.en; });
    texts.forEach(function (record) {
      record.node.nodeValue = record.english.match(/^\s*/)[0] + t(normalize(record.english)) + record.english.match(/\s*$/)[0];
    });
    splitLines.forEach(function (record) { record.element.textContent = t(record.english); });
    attributes.forEach(function (record) {
      record.element.setAttribute(record.name, language === "zh" ?
        record.element.getAttribute("data-zh-" + record.name) || t(record.english) : record.english);
    });
    doc.querySelectorAll("[data-decrypt]").forEach(function (element) {
      element.textContent = element.dataset.text;
    });
    doc.title = t(title);
    metadata.forEach(function (record) { record.element.content = t(record.english); });
    schemas.forEach(function (record) {
      var schema = JSON.parse(record.english);
      (schema["@graph"] || []).forEach(function (entity) {
        if (entity["@type"] === "SoftwareApplication") {
          entity.description = t(entity.description);
          entity.featureList = t(entity.featureList);
        }
        if (entity["@type"] === "FAQPage") {
          entity.mainEntity = Array.from(doc.querySelectorAll(".faq-item"), function (item) {
            return { "@type": "Question", name: normalize(item.querySelector(".faq-question").textContent),
              acceptedAnswer: { "@type": "Answer", text: normalize(item.querySelector(".faq-answer").textContent) } };
          });
        }
      });
      record.element.textContent = JSON.stringify(schema);
    });
    if (toggle) {
      var alternate = new URL(window.location.href);
      alternate.searchParams.set("lang", language === "zh" ? "en" : "zh");
      toggle.textContent = language === "zh" ? "EN" : "中";
      toggle.href = alternate.href;
      toggle.setAttribute("aria-label", language === "zh" ? "Switch to English" : "切换为中文");
      toggle.setAttribute("lang", language === "zh" ? "en" : "zh-CN");
    }
    window.dispatchEvent(new CustomEvent("meldwork:languagechange"));
  }
  window.MeldworkLocale = { language: language, t: t };
  applyLanguage(language);
  if (toggle) toggle.addEventListener("click", function (event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    // Preserve the reading anchor when translated paragraphs change height.
    var anchor = Array.from(doc.querySelectorAll("section[id] h2, section[id] p, .faq-question"))
      .find(function (element) {
        var rect = element.getBoundingClientRect();
        return rect.top >= 100 && rect.top < window.innerHeight && rect.height > 0;
      });
    var offset = anchor ? anchor.getBoundingClientRect().top : 0;
    var scroll = window.scrollY;
    var next = language === "zh" ? "en" : "zh";
    var currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set("lang", next);
    // file:// previews do not consistently allow history mutation in every browser.
    try { window.history.replaceState(null, "", currentUrl.href); } catch (error) {}
    applyLanguage(next);
    var delta = anchor ? anchor.getBoundingClientRect().top - offset : 0;
    window.scrollTo({ top: anchor ? window.scrollY + delta : scroll, behavior: "instant" });
  });
})();
