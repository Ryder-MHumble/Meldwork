const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('../../frontend/node_modules/jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const locale = fs.readFileSync(path.join(root, 'locale.js'), 'utf8');

function page(query = '') {
  const dom = new JSDOM(html, {
    url: 'file:///landing/index.html' + query,
    runScripts: 'outside-only',
  });
  dom.window.eval(locale);
  return dom;
}

test('explicit Chinese mode retains links, emphasis, and animation hooks', () => {
  const before = new JSDOM(html).window.document;
  const { document } = page('?lang=zh').window;
  assert.equal(document.documentElement.lang, 'zh-CN');
  for (const selector of ['strong', 'svg', 'a', '[data-split]', '[data-card-swap]']) {
    assert.equal(document.querySelectorAll(selector).length, before.querySelectorAll(selector).length);
  }
  assert.match(document.querySelector('#headline').textContent, /多 Agent/);
  assert.equal(document.querySelector('#boundary-title').textContent, '工作空间在本地，权限边界说清楚。');
  assert.match(document.querySelector('[data-decrypt]').dataset.text, /本地优先/);
  assert.equal(document.querySelector('#download .cta-primary').href, before.querySelector('#download .cta-primary').href);
});

test('English is the default and can switch to Chinese with its anchor', () => {
  const { document, MeldworkLocale } = page('#faq').window;
  assert.equal(document.documentElement.lang, 'en');
  assert.match(document.querySelector('#headline').textContent, /Multi-Agent Work,/);
  assert.equal(MeldworkLocale.t('Round 1 · Propose'), 'Round 1 · Propose');
  assert.equal(document.querySelector('#localeToggle').href, 'file:///landing/index.html?lang=zh#faq');
});

test('mode and motion labels use the selected language', () => {
  const { MeldworkLocale } = page('?lang=zh').window;
  assert.equal(MeldworkLocale.t('Direct'), '直接会话');
  assert.equal(MeldworkLocale.t('Pause background animation'), '暂停背景动画');
  assert.equal(MeldworkLocale.t('Resume background animation'), '继续背景动画');
});

test('language switches in place, round trips copy, and preserves open FAQ state', () => {
  const dom = page('?lang=en#faq');
  const win = dom.window;
  win.scrollTo = () => {};
  const answer = win.document.querySelector('.faq-item');
  answer.open = true;
  const original = win.document.querySelector('#headline').textContent;
  win.document.getElementById('localeToggle').click();
  assert.equal(win.document.documentElement.lang, 'zh-CN');
  assert.equal(answer.open, true);
  assert.match(win.document.querySelector('#headline').textContent, /多 Agent/);
  win.document.getElementById('localeToggle').click();
  assert.equal(win.document.documentElement.lang, 'en');
  assert.equal(win.document.querySelector('#headline').textContent, original);
  assert.equal(win.location.hash, '#faq');
  dom.window.close();
});

test('release metadata and download links target V1.0.4 and its actual DMG asset', () => {
  assert.doesNotMatch(html + locale, /1\.0\.3|0\.1\.3/);
  assert.match(html, /Meldwork-V1\.0\.4\/Meldwork-0\.1\.4-arm64\.dmg/);
  assert.match(html, /"softwareVersion": "1\.0\.4"/);
});

test('FAQ structured answers match the visible Chinese answers', () => {
  const { document } = page('?lang=zh').window;
  const schema = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent);
  const faq = schema['@graph'].find(item => item['@type'] === 'FAQPage');
  const items = Array.from(document.querySelectorAll('.faq-item'));
  assert.equal(faq.mainEntity.length, items.length);
  items.forEach((item, index) => {
    assert.equal(faq.mainEntity[index].name, item.querySelector('summary').textContent.trim());
    assert.equal(faq.mainEntity[index].acceptedAnswer.text, item.querySelector('.faq-answer').textContent.trim().replace(/\s+/g, ' '));
  });
});

test('chat demos distinguish direct follow-ups, concurrent replies and Agent mentions', () => {
  const dom = page();
  const win = dom.window;
  win.scrollTo = () => {};
  let advance;
  win.setTimeout = callback => { advance = callback; return 1; };
  win.clearTimeout = () => {};
  win.matchMedia = () => ({ matches: false, addEventListener() {} });
  Object.defineProperty(win.document, 'hidden', { value: false });
  win.IntersectionObserver = class { constructor(callback) { this.callback = callback; } observe() { this.callback([{ isIntersecting: true }]); } };
  win.eval(fs.readFileSync(path.join(root, 'run-demo.js'), 'utf8'));
  const demo = win.document.querySelector('[data-run-demo]');
  function select(mode) { demo.querySelector('[data-run-mode=' + mode + ']').click(); }
  select('direct');
  advance();
  assert.equal(demo.querySelectorAll('.run-typing').length, 1);
  advance(); advance(); advance();
  assert.match(demo.textContent, /What should we measure/);
  assert.equal(demo.querySelectorAll('[data-speaker="Claude"]').length, 0);
  select('concurrent');
  advance();
  assert.equal(demo.querySelectorAll('.run-typing').length, 3);
  advance();
  assert.equal(demo.querySelectorAll('.run-message:not(.is-user)').length, 3);
  assert.equal(demo.querySelectorAll('.run-mention').length, 0);
  select('auto');
  advance(); advance(); advance();
  assert.deepEqual(Array.from(demo.querySelectorAll('.run-mention'), el => el.textContent), ['@Claude', '@Gemini', '@Codex']);
  demo.querySelector('[data-run-pause]').click();
  win.document.getElementById('localeToggle').click();
  assert.equal(demo.dataset.phase, '3');
  assert.match(demo.textContent, /需要哪些证据/);
  assert.equal(demo.querySelectorAll('.run-message.is-new').length, 0);
  dom.window.close();
});

function scenePage(reduced = false) {
  const dom = page();
  const win = dom.window;
  const callbacks = new Map();
  const uniforms = {};
  let id = 0;
  let rendered = null;
  Object.defineProperty(win.document, 'hidden', { value: false, configurable: true });
  Object.defineProperty(win.document.querySelector('.hero'), 'offsetHeight', { value: 900 });
  win.scrollY = 1200;
  win.Math.random = () => 0.3;
  win.matchMedia = () => ({ matches: reduced, addEventListener() {} });
  win.ResizeObserver = class { observe() {} };
  win.requestAnimationFrame = callback => { callbacks.set(++id, callback); return id; };
  win.cancelAnimationFrame = frame => callbacks.delete(frame);
  const gl = new Proxy({
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: (_, name) => name,
    uniform1f: (name, value) => { uniforms[name] = value; },
    drawArrays: () => { rendered = { ...uniforms }; },
  }, { get: (target, key) => target[key] || (() => ({})) });
  win.HTMLCanvasElement.prototype.getContext = type => { assert.equal(type, 'webgl2'); return gl; };
  win.eval(fs.readFileSync(path.join(root, 'chapter-scene.js'), 'utf8'));
  return {
    dom,
    rendered: () => rendered,
    pending: () => callbacks.size,
    tick(time) {
      const pending = Array.from(callbacks.values());
      callbacks.clear();
      pending.forEach(callback => callback(time));
    },
    pointer(x, y) {
      win.dispatchEvent(new win.MouseEvent('pointermove', { clientX: x, clientY: y }));
    },
  };
}

test('landing uses the exact CLI loading fragment shader and visual parameters', () => {
  const desktop = fs.readFileSync(path.join(root, '../frontend/src/components/PixelBlast.vue'), 'utf8');
  const landing = fs.readFileSync(path.join(root, 'chapter-scene.js'), 'utf8');
  const shader = /(?:const|var) FRAGMENT_SHADER = `([\s\S]*?)`/;
  assert.equal(landing.match(shader)[1], desktop.match(shader)[1]);
  assert.doesNotMatch(landing, /pointermove|mousemove|bulgeStrength|cursorRadius/);
  const scene = scenePage();
  assert.equal(scene.rendered().uScale, 2.2);
  assert.equal(scene.rendered().uDensity, 1.26);
  assert.equal(scene.rendered().uOpacity, 0.42);
  assert.equal(scene.rendered().uPixelSize, 3.7);
  scene.dom.window.close();
});

test('PixelBlast advances without mouse input at CLI loading speed; scroll does not reset its clock', () => {
  const scene = scenePage();
  const win = scene.dom.window;
  const initial = scene.rendered().uTime;
  scene.tick(1000);
  scene.tick(1016);
  assert.ok(Math.abs(scene.rendered().uTime - initial - 16 * 0.00036) < 1e-8);
  const beforeScroll = scene.rendered();
  win.scrollY += 200;
  win.dispatchEvent(new win.Event('scroll'));
  scene.pointer(400, 300);
  assert.deepEqual(scene.rendered(), beforeScroll);
  scene.tick(1032);
  assert.ok(Math.abs(scene.rendered().uTime - initial - 32 * 0.00036) < 1e-8);
  win.document.getElementById('chapterMotionToggle').click();
  const paused = scene.rendered();
  scene.pointer(500, 400);
  scene.tick(2000);
  assert.deepEqual(scene.rendered(), paused);
  assert.equal(scene.pending(), 0);
  win.document.getElementById('chapterMotionToggle').click();
  assert.equal(scene.pending(), 1);
  win.scrollY = 0;
  win.dispatchEvent(new win.Event('scroll'));
  assert.equal(scene.pending(), 0);
  scene.dom.window.close();
});

test('PixelBlast reduced-motion mode renders once and schedules no frames', () => {
  const scene = scenePage(true);
  const initial = scene.rendered();
  assert.ok(initial);
  scene.pointer(200, 200);
  scene.tick(1000);
  assert.deepEqual(scene.rendered(), initial);
  assert.equal(scene.pending(), 0);
  assert.equal(scene.dom.window.document.getElementById('chapterMotionToggle').hidden, true);
  scene.dom.window.close();
});
