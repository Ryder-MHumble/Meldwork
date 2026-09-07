(function () {
  "use strict";
  var root = document.querySelector("[data-run-demo]");
  if (!root) return;
  var tabs = Array.from(root.querySelectorAll("[data-run-mode]"));
  var feed = root.querySelector(".run-chat");
  var list = root.querySelector("[data-run-messages]");
  var renderedKey = "", renderedCount = 0;
  var pause = root.querySelector("[data-run-pause]");
  var motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var mode = "auto", phase = 0, timer = 0, visible = false, paused = false;
  var descriptions = {
    direct: ["Work with one selected Agent. Follow up in the same conversation; you decide the next question.", "与一个选定的 Agent 持续对话，由你提问、追问并决定下一步。"],
    concurrent: ["Send the same task to your selected Agents at once. Each replies independently, so you can compare their approaches.", "把同一个任务同时发给所选 Agent。它们各自独立回复，由你比较不同方案。"],
    auto: ["Agents start with independent ideas, then build on the discussion and @mention peers to invite the next reply. You choose who participates.", "Agent 先独立提出想法，再自主接续讨论，通过 @ 邀请其他 Agent 回应。参与者由你选择。"]
  };
  var task = ["You", ["Review this product launch plan.", "评审这份产品发布方案。"]];
  var conversations = {
    direct: [
      [task],
      [["Codex", null]],
      [["Codex", ["Start with a small pilot. Test onboarding and define a rollback plan before expanding.", "建议先小范围试用，验证引导流程，并在扩大发布前明确回退方案。"]]],
      [["You", ["What should we measure in the pilot?", "试用阶段应该关注哪些指标？"]]],
      [["Codex", ["Track first-task completion, repeat use, and unresolved issues. Review the results after one week.", "关注首次任务完成率、重复使用和未解决问题，一周后集中复盘。"]]]
    ],
    concurrent: [
      [task],
      [["Codex", null], ["Claude", null], ["Gemini", null]],
      [["Codex", ["Check installation, error recovery, and the rollback path before launch.", "发布前检查安装流程、异常恢复和回退路径。"]],
       ["Claude", ["Narrow the launch message to one clear use case. Avoid promising too much.", "发布信息聚焦一个明确场景，避免过度承诺。"]],
       ["Gemini", ["Recruit a small pilot group and compare task completion with their current workflow.", "招募小规模试用用户，对比新旧流程的任务完成情况。"]]],
      [],
      [["You", ["Three useful perspectives. I'll combine the engineering checks, focused message, and pilot plan.", "三个角度都很有用，我会整合工程检查、核心信息和试用计划。"]]]
    ],
    auto: [
      [task, ["Codex", ["I'd begin with a limited pilot.", "我建议从小范围试用开始。"]],
       ["Claude", ["The audience and launch message need a sharper focus.", "目标用户和发布信息还需要更聚焦。"]],
       ["Gemini", ["We need evidence of repeat use before expanding.", "扩大发布前，需要验证用户会持续使用。"]]],
      [["Codex", ["Let's make the pilot the first milestone. @Claude can you challenge the positioning?", "把试用作为第一个里程碑。@Claude 请复核一下产品定位。"]]],
      [["Claude", ["Lead with multi-Agent review, not full automation. @Gemini what evidence would support that promise?", "重点突出多 Agent 复核，避免承诺全自动化。@Gemini 需要哪些证据支撑这个定位？"]]],
      [["Gemini", ["Measure whether users compare replies and return to the same task. @Codex can you add those checks?", "衡量用户是否比较回复、是否继续同一个任务。@Codex 能把这些检查加入方案吗？"]]],
      [["Codex", ["Updated: a one-week pilot focused on review, with repeat-use metrics and a rollback plan.", "已完善：进行一周复核场景试用，加入重复使用指标和回退方案。"]]]
    ]
  };
  function renderMessages() {
    var language = window.MeldworkLocale.language;
    var key = mode + ":" + phase + ":" + language;
    if (key === renderedKey) return;
    var sameRun = renderedKey.startsWith(mode + ":") && renderedKey.endsWith(":" + language);
    var messages = [];
    for (var step = 0; step <= phase; step++) {
      conversations[mode][step].forEach(function (message) {
        if (message[1] || step === phase) messages.push(message);
      });
    }
    var previousCount = sameRun ? renderedCount : 0;
    var languageOnly = renderedKey.split(":").slice(0, 2).join(":") === mode + ":" + phase;
    var oldScroll = feed.scrollTop;
    list.replaceChildren();
    messages.forEach(function (message, index) {
      var row = document.createElement("li");
      row.className = "run-message" + (message[0] === "You" ? " is-user" : "");
      if (!languageOnly && index >= previousCount && !motion.matches && !paused && visible) row.classList.add("is-new");
      row.dataset.speaker = message[0];
      var avatar = document.createElement("span");
      avatar.className = "run-chat-avatar";
      if (message[0] === "You") avatar.textContent = say(["You", "你"]);
      else {
        var image = document.createElement("img");
        image.src = "assets/agents/" + ({ Codex: "codex.svg", Claude: "claude.png", Gemini: "gemini.svg" })[message[0]];
        image.alt = "";
        avatar.appendChild(image);
      }
      var bubble = document.createElement("div");
      bubble.className = "run-chat-bubble";
      var author = document.createElement("strong");
      author.textContent = message[0] === "You" ? say(["You", "你"]) : message[0];
      bubble.appendChild(author);
      if (message[1]) {
        var paragraph = document.createElement("p");
        say(message[1]).split(/(@Codex|@Claude|@Gemini)/g).forEach(function (part) {
          var node = document.createElement("span");
          if (part.startsWith("@")) node.className = "run-mention";
          node.textContent = part;
          paragraph.appendChild(node);
        });
        bubble.appendChild(paragraph);
      } else {
        var typing = document.createElement("span");
        typing.className = "run-typing";
        typing.setAttribute("aria-label", say(["Replying", "正在回复"]));
        for (var dot = 0; dot < 3; dot++) typing.appendChild(document.createElement("i"));
        bubble.appendChild(typing);
      }
      row.append(avatar, bubble);
      list.appendChild(row);
    });
    feed.setAttribute("aria-label", say(["Example conversation", "示例对话"]));
    feed.scrollTop = languageOnly ? oldScroll : feed.scrollHeight;
    renderedKey = key;
    renderedCount = messages.filter(function (message) { return message[1]; }).length;
  }
  var stages = {
    direct: [["Send to Codex", "发给 Codex"], ["Codex works on your task", "Codex 处理任务"], ["Read the reply", "查看回复"], ["You ask a follow-up", "你继续追问"], ["Continue the same conversation", "延续同一段会话"]],
    concurrent: [["One task reaches three Agents", "同一个任务到达三个 Agent"], ["Three Agents work independently", "三个 Agent 独立处理"], ["Replies arrive as Agents finish", "各 Agent 完成后陆续回复"], ["Each perspective stays separate", "每个观点独立保留"], ["Compare the three replies", "比较三份回复"]],
    auto: [["Everyone proposes independently", "各自提出初步想法"], ["Codex invites Claude to review", "Codex 邀请 Claude 复核"], ["Claude asks Gemini to check evidence", "Claude 请 Gemini 核查依据"], ["Gemini asks Codex to revise", "Gemini 请 Codex 完善方案"], ["Codex incorporates the peer feedback", "Codex 结合同伴反馈完善方案"]]
  };
  function say(pair) { return pair[window.MeldworkLocale.language === "zh" ? 1 : 0]; }
  function render() {
    root.dataset.mode = mode;
    root.dataset.phase = String(phase);
    root.classList.toggle("is-paused", paused || motion.matches || !visible || document.hidden);
    tabs.forEach(function (tab) {
      var selected = tab.dataset.runMode === mode;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    root.querySelector("[role=tabpanel]").setAttribute("aria-labelledby", "run-" + mode);
    root.querySelector("[data-run-description]").textContent = say(descriptions[mode]);
    root.querySelector("[data-run-status]").textContent = say(stages[mode][phase]);
    renderMessages();
    root.querySelectorAll(".run-progress i").forEach(function (segment, index) { segment.classList.toggle("is-complete", index <= phase); });
    var label = say(paused ? ["Resume demo", "继续演示"] : ["Pause demo", "暂停演示"]);
    pause.setAttribute("aria-label", label);
    pause.title = label;
    pause.setAttribute("aria-pressed", String(paused));
    pause.hidden = motion.matches;
  }
  function schedule() {
    clearTimeout(timer);
    render();
    if (visible && !paused && !motion.matches && !document.hidden) {
      timer = setTimeout(function () { phase = (phase + 1) % 5; schedule(); }, phase === 4 ? 3400 : 2400);
    }
  }
  function select(tab) { mode = tab.dataset.runMode; phase = motion.matches ? 4 : 0; schedule(); }
  tabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () { select(tab); });
    tab.addEventListener("keydown", function (event) {
      var next = index;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault(); tabs[next].focus(); select(tabs[next]);
    });
  });
  pause.addEventListener("click", function () { paused = !paused; schedule(); });
  document.addEventListener("visibilitychange", schedule);
  window.addEventListener("meldwork:languagechange", render);
  motion.addEventListener("change", function () { phase = motion.matches ? 4 : 0; schedule(); });
  new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; schedule(); }, { threshold: 0.15 }).observe(root);
  if (motion.matches) phase = 4;
  render();
})();
