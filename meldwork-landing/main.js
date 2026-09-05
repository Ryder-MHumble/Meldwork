(function () {
  "use strict";

  var root = document.documentElement;
  var motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  var localeToggle = document.getElementById("localeToggle");
  var themeToggle = document.getElementById("themeToggle");
  var motionToggle = document.getElementById("motionToggle");
  var locale = "en";
  var userPaused = false;
  var playbackBlocked = false;

  function readPreference(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }
  function storePreference(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* Preferences are optional. */ }
  }
  function readableText(element) {
    return element.textContent.replace(/\s+/g, " ").trim();
  }
  function syncMotionLabel() {
    if (!motionToggle) return;
    motionToggle.disabled = motionPreference.matches;
    var paused = userPaused || motionPreference.matches || playbackBlocked;
    var text = motionPreference.matches ? (locale === "zh" ? "静态背景" : "Static background")
      : (locale === "zh" ? (paused ? "播放背景动画" : "暂停背景动画") : (paused ? "Play background animation" : "Pause background animation"));
    motionToggle.setAttribute("aria-label", text);
    motionToggle.setAttribute("title", text);
    motionToggle.setAttribute("aria-pressed", String(!paused));
    var label = motionToggle.querySelector("[data-motion-label]");
    if (label) label.textContent = text;
    motionToggle.dataset.paused = String(paused);
  }
  function applyLocale(next) {
    locale = next === "zh" ? "zh" : "en";
    root.lang = locale === "zh" ? "zh-CN" : "en";
    document.querySelectorAll("[data-en][data-zh]").forEach(function (element) {
      element.textContent = element.dataset[locale];
    });
    ["aria-label", "alt", "title"].forEach(function (attribute) {
      document.querySelectorAll("[data-en-" + attribute + "]").forEach(function (element) {
        var value = element.getAttribute("data-" + locale + "-" + attribute);
        if (value !== null) element.setAttribute(attribute, value);
      });
    });
    if (localeToggle) {
      localeToggle.textContent = locale === "zh" ? "EN" : "中文";
      localeToggle.setAttribute("aria-label", locale === "zh" ? "Switch to English" : "切换为中文");
      localeToggle.setAttribute("lang", locale === "zh" ? "en" : "zh-CN");
    }
    document.querySelectorAll("meta[data-en-content]").forEach(function (meta) {
      meta.content = meta.getAttribute("data-" + locale + "-content");
    });
    // Keep machine-readable answers identical to the visible, selected language.
    var schema = document.querySelector('script[type="application/ld+json"]');
    if (schema) {
      var data = JSON.parse(schema.textContent);
      var graph = data["@graph"] || [];
      var faq = graph.find(function (entry) { return entry["@type"] === "FAQPage"; });
      if (faq) faq.mainEntity = Array.from(document.querySelectorAll(".faq-item")).map(function (item) {
        return {
          "@type": "Question",
          name: readableText(item.querySelector("summary")),
          acceptedAnswer: { "@type": "Answer", text: readableText(item.querySelector(".faq-answer")) }
        };
      });
      var app = graph.find(function (entry) { return entry["@type"] === "SoftwareApplication"; });
      var definition = document.querySelector("[data-schema-description]");
      if (app && definition) app.description = readableText(definition);
      schema.textContent = JSON.stringify(data);
    }
    syncMotionLabel();
  }
  function applyTheme(theme) {
    root.dataset.theme = theme === "light" ? "light" : "dark";
    document.querySelectorAll("[data-theme-src]").forEach(function (image) {
      if (!image.dataset.darkSrc) image.dataset.darkSrc = image.getAttribute("src");
      image.src = root.dataset.theme === "light" ? image.dataset.themeSrc : image.dataset.darkSrc;
    });
    if (themeToggle) themeToggle.setAttribute("aria-pressed", String(root.dataset.theme === "light"));
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = root.dataset.theme === "light" ? "#f7f8fa" : "#08090b";
  }

  applyLocale(readPreference("meldwork-locale") || (navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en"));
  applyTheme(readPreference("meldwork-theme"));
  if (localeToggle) localeToggle.addEventListener("click", function () {
    applyLocale(locale === "zh" ? "en" : "zh");
    storePreference("meldwork-locale", locale);
    requestScrollUpdate();
  });
  if (themeToggle) themeToggle.addEventListener("click", function () {
    applyTheme(root.dataset.theme === "light" ? "dark" : "light");
    storePreference("meldwork-theme", root.dataset.theme);
  });

  var productTabs = Array.from(document.querySelectorAll("[data-product-tab]"));
  function selectProduct(index, focus) {
    productTabs.forEach(function (tab, tabIndex) {
      var selected = tabIndex === index;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      var panel = document.getElementById(tab.getAttribute("aria-controls"));
      if (panel) panel.hidden = !selected;
      if (selected && focus) tab.focus({ preventScroll: true });
    });
  }
  productTabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () { selectProduct(index, false); });
    tab.addEventListener("keydown", function (event) {
      var target;
      if (event.key === "ArrowRight") target = (index + 1) % productTabs.length;
      if (event.key === "ArrowLeft") target = (index + productTabs.length - 1) % productTabs.length;
      if (event.key === "Home") target = 0;
      if (event.key === "End") target = productTabs.length - 1;
      if (target !== undefined) { event.preventDefault(); selectProduct(target, true); }
    });
  });
  selectProduct(0, false);

  var burger = document.getElementById("burger");
  var menu = document.getElementById("mobileMenu");
  var overlay = document.getElementById("overlay");
  var menuOpen = false;
  function setMenu(open, restoreFocus) {
    if (!burger || !menu || !overlay) return;
    menuOpen = open;
    burger.setAttribute("aria-expanded", String(open));
    menu.hidden = !open;
    overlay.hidden = !open;
    document.body.classList.toggle("menu-open", open);
    document.querySelectorAll("main, footer").forEach(function (element) { element.inert = open; });
    if (open) menu.querySelector("a").focus();
    else if (restoreFocus) burger.focus({ preventScroll: true });
  }
  if (burger) burger.addEventListener("click", function () { setMenu(!menuOpen, true); });
  if (overlay) overlay.addEventListener("click", function () { setMenu(false, true); });
  if (menu) menu.addEventListener("click", function (event) {
    var link = event.target.closest("a");
    if (!link) return;
    setMenu(false, false);
    var destination = link.hash && document.getElementById(link.hash.slice(1));
    if (destination) {
      destination.tabIndex = -1;
      destination.focus({ preventScroll: true });
    }
  });
  document.addEventListener("keydown", function (event) {
    if (!menuOpen) return;
    if (event.key === "Escape") { event.preventDefault(); setMenu(false, true); }
    if (event.key === "Tab") {
      var focusable = [burger].concat(Array.from(menu.querySelectorAll("a")));
      var current = focusable.indexOf(document.activeElement);
      var next = (current + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
      event.preventDefault();
      focusable[next].focus();
    }
  });

  var hero = document.querySelector(".hero");
  var background = document.querySelector(".bg");
  var videos = [document.getElementById("bgVideoA"), document.getElementById("bgVideoB")].filter(Boolean);
  var active = videos[0];
  var standby = videos[1];
  var videoFrame = 0;
  var fadeTimer = 0;
  var fading = false;
  var heroVisible = true;
  var loaded = false;
  var fadeSeconds = 0.9;

  function shouldPlay() {
    return heroVisible && !document.hidden && !motionPreference.matches && !userPaused && !playbackBlocked;
  }
  function loadVideos() {
    if (loaded) return;
    loaded = true;
    videos.forEach(function (video) {
      video.muted = true;
      video.loop = true;
      video.querySelectorAll("source[data-src]").forEach(function (source) { source.src = source.dataset.src; });
      video.load();
    });
  }
  function stopVideo() {
    cancelAnimationFrame(videoFrame);
    videoFrame = 0;
    clearTimeout(fadeTimer);
    fading = false;
    videos.forEach(function (video) { video.pause(); });
    if (standby) standby.style.opacity = "0";
    syncMotionLabel();
  }
  function tickVideo() {
    videoFrame = 0;
    if (!shouldPlay() || !active) { stopVideo(); return; }
    if (!fading && standby && standby.readyState >= 2 && active.duration > fadeSeconds * 2 && active.currentTime >= active.duration - fadeSeconds - 0.15) {
      fading = true;
      var outgoing = active;
      var incoming = standby;
      incoming.currentTime = 0;
      incoming.style.zIndex = "2";
      outgoing.style.zIndex = "1";
      incoming.play().then(function () {
        if (!shouldPlay()) { incoming.pause(); fading = false; return; }
        incoming.style.opacity = "1";
        active = incoming;
        standby = outgoing;
        fadeTimer = window.setTimeout(function () {
          outgoing.pause();
          outgoing.style.opacity = "0";
          fading = false;
        }, fadeSeconds * 1000);
      }).catch(function () { fading = false; });
    }
    videoFrame = requestAnimationFrame(tickVideo);
  }
  function updateVideo() {
    syncMotionLabel();
    if (!shouldPlay() || !active) { stopVideo(); return; }
    loadVideos();
    if (!active.paused && videoFrame) return;
    active.play().then(function () {
      if (!shouldPlay()) { stopVideo(); return; }
      active.style.opacity = "1";
      if (!videoFrame) videoFrame = requestAnimationFrame(tickVideo);
    }).catch(function (error) {
      if (error.name === "AbortError" || !shouldPlay()) return;
      playbackBlocked = true;
      stopVideo();
      videos.forEach(function (video) { video.style.opacity = "0"; });
      syncMotionLabel();
    });
  }
  videos.forEach(function (video) {
    video.addEventListener("error", function () {
      video.style.opacity = "0";
      if (video === active) { playbackBlocked = true; stopVideo(); syncMotionLabel(); }
    }, true);
  });
  if (motionToggle) motionToggle.addEventListener("click", function () {
    if (motionPreference.matches) return;
    userPaused = !userPaused;
    if (playbackBlocked) { playbackBlocked = false; userPaused = false; }
    updateVideo();
  });
  function updateMotionPreference() {
    if (motionPreference.matches) videos.forEach(function (video) { video.style.opacity = "0"; });
    updateVideo();
  }
  motionPreference.addEventListener("change", updateMotionPreference);
  document.addEventListener("visibilitychange", updateVideo);
  if (navigator.connection && navigator.connection.saveData) userPaused = true;

  var nav = document.getElementById("topnav");
  var progressBar = document.querySelector(".scroll-progress span");
  var spyLinks = Array.from(document.querySelectorAll("[data-spy]"));
  var scrollFrame = 0;
  function updateScroll() {
    scrollFrame = 0;
    var y = window.scrollY;
    if (nav) nav.classList.toggle("scrolled", y > 12);
    if (hero && background) {
      // One viewport-sized scene dissolves before the body sections take over.
      var height = Math.max(hero.offsetHeight, 1);
      var progress = Math.min(Math.max(y / (height * 0.9), 0), 1);
      var eased = progress * progress * (3 - 2 * progress);
      background.style.setProperty("--scene-opacity", String(1 - eased));
      var visible = progress < 1;
      if (visible !== heroVisible) { heroVisible = visible; updateVideo(); }
    }
    var max = root.scrollHeight - window.innerHeight;
    if (progressBar) progressBar.style.transform = "scaleX(" + (max > 0 ? Math.min(y / max, 1) : 0) + ")";
    var current = null;
    spyLinks.forEach(function (link) {
      var target = document.getElementById(link.dataset.spy);
      if (target && target.getBoundingClientRect().top <= window.innerHeight * 0.35) current = link;
    });
    spyLinks.forEach(function (link) {
      link.classList.toggle("active", link === current);
      if (link === current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }
  function requestScrollUpdate() {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScroll);
  }
  window.addEventListener("scroll", requestScrollUpdate, { passive: true });
  window.addEventListener("resize", function () {
    if (window.innerWidth > 860 && menuOpen) setMenu(false, false);
    requestScrollUpdate();
  });
  window.addEventListener("pageshow", function () { updateScroll(); updateVideo(); });
  window.addEventListener("pagehide", stopVideo);
  root.classList.add("js");
  updateScroll();
  updateMotionPreference();
})();
