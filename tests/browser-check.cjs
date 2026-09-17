const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-landing-check-'));
console.log('Screenshots: ' + output);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await page.waitForTimeout(600);
    const expandedNav = await page.locator('#topnav').boundingBox();
    assert.equal(expandedNav.x, 0);
    assert.equal(expandedNav.width, 1440);
    assert.equal(await page.locator('#topnav').evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
    await page.screenshot({ path: path.join(output, 'nav-home.png') });
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.sameDocument = true; });
    await page.locator('#scenario').evaluate(el => window.scrollTo(0, el.offsetTop - 110));
    await page.waitForTimeout(500);
    const compactNav = await page.locator('#topnav').boundingBox();
    assert.ok(compactNav.width < expandedNav.width && compactNav.height < expandedNav.height);
    await page.screenshot({ path: path.join(output, 'nav-scrolled.png') });
    const demo = page.locator('[data-run-demo]');
    await page.locator('[data-run-pause]').click();
    const before = await demo.getAttribute('data-phase');
    await page.waitForTimeout(2600);
    assert.equal(await demo.getAttribute('data-phase'), before, 'pause freezes the phase');
    for (const mode of ['direct', 'concurrent', 'auto']) {
      await page.locator('[data-run-mode=' + mode + ']').click();
      assert.equal(await demo.getAttribute('data-mode'), mode);
      assert.ok(await page.locator('.run-message').count() > 0);
      const tabStyle = await page.locator('[data-run-mode=' + mode + ']').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopWidth }));
      assert.equal(tabStyle.background, 'rgba(0, 0, 0, 0)');
      assert.equal(tabStyle.border, '0px');
      assert.ok((await page.locator('[data-run-description]').textContent()).length > 60);
      await page.screenshot({ path: path.join(output, 'desktop-' + mode + '.png') });
    }
    await page.locator('[data-run-mode=direct]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await demo.getAttribute('data-mode'), 'concurrent', 'tabs support arrow keys');
    await page.locator('[data-run-mode=auto]').click();
    await page.locator('[data-run-pause]').click();
    await page.waitForFunction(() => document.querySelector('[data-run-demo]').dataset.phase === '1');
    assert.equal(await page.locator('.run-mention').last().textContent(), '@Claude');
    await page.screenshot({ path: path.join(output, 'desktop-handoff.png') });
    await page.waitForFunction(() => document.querySelector('[data-run-demo]').dataset.phase === '2');
    assert.equal(await page.locator('.run-mention').last().textContent(), '@Gemini');
    await page.waitForFunction(() => document.querySelector('[data-run-demo]').dataset.phase === '3');
    assert.equal(await page.locator('.run-mention').last().textContent(), '@Codex');
    await page.locator('[data-run-pause]').click();

    const question = page.locator('.faq-question');
    await question.nth(1).click();
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.faq-item[open]').count(), 1);
    await question.nth(2).click();
    assert.ok(await page.locator('.faq-item').evaluateAll(items => items.some(item => item.getAnimations().length > 0)), 'FAQ animates');
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.faq-item[open]').count(), 1);
    assert.equal(await page.locator('.faq-item').nth(2).getAttribute('open'), '');
    await question.nth(2).click();
    await question.nth(3).click();
    await question.nth(1).click();
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.faq-item[open]').count(), 1, 'rapid clicks retain exclusivity');

    const anchor = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('section[id] h2, section[id] p, .faq-question'));
      const index = elements.findIndex(el => { const r = el.getBoundingClientRect(); return r.top >= 100 && r.top < innerHeight && r.height > 0; });
      return { index, top: elements[index].getBoundingClientRect().top };
    });
    await page.locator('#localeToggle').click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    assert.equal(await page.evaluate(() => window.sameDocument), true, 'language does not reload');
    const after = await page.evaluate(index => document.querySelectorAll('section[id] h2, section[id] p, .faq-question')[index].getBoundingClientRect().top, anchor.index);
    assert.ok(Math.abs(after - anchor.top) < 3, 'reading anchor stays in place: ' + anchor.top + ' -> ' + after);
    assert.equal(await page.locator('.faq-item[open]').count(), 1);
    assert.equal(await demo.getAttribute('data-mode'), 'auto');
    await page.screenshot({ path: path.join(output, 'faq-zh.png') });

    for (const [name, width, height] of [['desktop', 1440, 1000], ['tablet', 900, 1000], ['mobile', 390, 844], ['narrow', 320, 740]]) {
      await page.setViewportSize({ width, height });
      await page.locator('#scenario').evaluate(el => window.scrollTo(0, el.offsetTop - 110));
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, name + ' has no overflow');
      const nav = await page.locator('#topnav').boundingBox();
      assert.ok(nav.x >= 10 && nav.x + nav.width <= width - 10, name + ' floating nav');
      const left = await page.locator('.nav-start').boundingBox();
      const right = await page.locator('.nav-actions').boundingBox();
      assert.ok(left.x + left.width < right.x, name + ' navigation groups do not overlap');
      assert.ok(right.x + right.width >= nav.x + nav.width - 20, name + ' actions align right');
      assert.equal(await page.locator('.nav-actions .cta-dark').isVisible(), true);
      assert.equal(await page.locator('.run-chat-avatar img').evaluateAll(images => images.length > 0 && images.every(img => img.complete && img.naturalWidth > 0)), true, 'logos load');
      const canvas = page.locator('#chapterCanvas');
      const pixels = await canvas.evaluate(c => {
        const gl = c.getContext('webgl2');
        const data = new Uint8Array(c.width * c.height * 4);
        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        let count = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i]) count++;
        return count;
      });
      assert.ok(pixels > 100, name + ' background is nonblank');
      const first = await canvas.evaluate(c => c.toDataURL());
      await page.waitForTimeout(500);
      assert.notEqual(await canvas.evaluate(c => c.toDataURL()), first, name + ' background moves');
      await page.screenshot({ path: path.join(output, name + '-zh.png') });
      await page.locator('#localeToggle').click();
      await page.screenshot({ path: path.join(output, name + '-en.png') });
      await page.locator('#themeToggle').click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(output, name + '-light.png') });
      await page.locator('#themeToggle').click();
      await page.locator('#localeToggle').click();
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.querySelector('[data-run-pause]').hidden);
    assert.equal(await page.locator('[data-run-pause]').isVisible(), false);
    assert.equal(await demo.getAttribute('data-phase'), '4');
    const reduced = await page.locator('#chapterCanvas').evaluate(c => c.toDataURL());
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#chapterCanvas').evaluate(c => c.toDataURL()), reduced);
    assert.deepEqual(errors, []);
    console.log('PASS: FAQ, locale anchor, release UI, mode tabs, @handoff, pause, reduced motion, responsive canvases and logos.');
    console.log('Screenshots: ' + output);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
