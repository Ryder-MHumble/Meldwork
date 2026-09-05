const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const site = path.resolve(__dirname, '..');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-landing-check-'));
let browser;
let server;
let origin;

before(async () => {
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(site, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.png': 'image/png' };
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  console.log('Screenshots: ' + artifacts);
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function openPage(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', ...options });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  return page;
}

test('static content, release facts, source links and FAQ schema agree without JavaScript', async () => {
  const page = await openPage({ javaScriptEnabled: false });
  const facts = await page.evaluate(() => {
    const graph = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent)['@graph'];
    return {
      h1: document.querySelector('h1').textContent.trim(),
      mains: document.querySelectorAll('main').length,
      app: graph.find(item => item['@type'] === 'SoftwareApplication'),
      schema: graph.find(item => item['@type'] === 'FAQPage').mainEntity,
      faqs: Array.from(document.querySelectorAll('.faq-item'), item => ({ name: item.querySelector('summary').textContent.replace(/\s+/g, ' ').trim(), text: item.querySelector('.faq-answer').textContent.replace(/\s+/g, ' ').trim() })),
      badAnchors: Array.from(document.querySelectorAll('a[href^="#"]'), a => a.hash).filter(hash => !document.getElementById(hash.slice(1))),
      downloads: Array.from(document.querySelectorAll('a[href$=".dmg"]'), a => a.href),
      hiddenHeadings: Array.from(document.querySelectorAll('h1,h2')).filter(el => getComputedStyle(el).opacity === '0').length
    };
  });
  assert.equal(facts.h1, 'Meldwork');
  assert.equal(facts.mains, 1);
  assert.equal(facts.app.softwareVersion, '0.1.4');
  assert.equal(facts.app.applicationCategory, 'ProductivityApplication');
  assert.match(facts.app.license, /\/LICENSE$/);
  assert.deepEqual(facts.badAnchors, []);
  assert.equal(facts.hiddenHeadings, 0);
  assert.equal(await page.locator('#localeToggle').isVisible(), false);
  assert.equal(await page.locator('#motionToggle').isVisible(), false);
  assert.equal(await page.locator('#themeToggle').isVisible(), false);
  assert.ok(facts.downloads.length >= 2);
  facts.downloads.forEach(url => assert.match(url, /Meldwork-V1\.0\.4\/Meldwork-0\.1\.4-arm64\.dmg$/));
  assert.deepEqual(facts.schema.map(item => ({ name: item.name, text: item.acceptedAnswer.text })), facts.faqs);
  await page.locator('.faq-item summary').first().click();
  assert.equal(await page.locator('.faq-item').first().getAttribute('open'), '');
  await page.screenshot({ path: path.join(artifacts, 'no-js.png'), fullPage: true });
  await page.close();
});

test('Chinese, metadata, FAQ, image descriptions and preference survive reload', async () => {
  const page = await openPage();
  await page.locator('#localeToggle').click();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  const result = await page.evaluate(() => {
    const untranslated = Array.from(document.querySelectorAll('[data-en][data-zh]')).filter(el => el.textContent !== el.dataset.zh);
    const graph = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent)['@graph'];
    return { untranslated: untranslated.map(el => el.tagName), title: document.title, description: document.querySelector('meta[name="description"]').content,
      faq: graph.find(item => item['@type'] === 'FAQPage').mainEntity[0].acceptedAnswer.text,
      visible: document.querySelector('.faq-answer').textContent.trim() };
  });
  assert.deepEqual(result.untranslated, []);
  assert.match(result.title, /[\u4e00-\u9fff]/);
  assert.match(result.description, /[\u4e00-\u9fff]/);
  assert.equal(result.faq, result.visible);
  await page.locator('#themeToggle').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.screenshot({ path: path.join(artifacts, 'desktop-zh-light.png'), fullPage: true });
  await page.close();
});

test('product tabs are keyboard navigable, stable in size and show uncropped screenshots', async () => {
  const page = await openPage();
  const tabs = page.locator('[data-product-tab]');
  await tabs.first().focus();
  const sizes = [];
  for (let i = 0; i < 4; i++) {
    const panel = page.locator('.product-panel:not([hidden])');
    assert.equal(await panel.count(), 1);
    assert.equal(await tabs.nth(i).getAttribute('aria-selected'), 'true');
    await panel.locator('img').evaluate(img => img.decode());
    const dimensions = await panel.locator('img').evaluate(img => ({ fit: getComputedStyle(img).objectFit, w: img.naturalWidth, h: img.naturalHeight }));
    assert.equal(dimensions.fit, 'contain');
    assert.ok(dimensions.w >= 1440 && dimensions.h >= 900);
    sizes.push((await panel.boundingBox()).height);
    if (i < 3) await page.keyboard.press('ArrowRight');
  }
  assert.ok(Math.max(...sizes) - Math.min(...sizes) < 50, 'Product tabs should not substantially shift the next section');
  await page.keyboard.press('Home');
  assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
  assert.equal(await tabs.first().evaluate(el => document.activeElement === el), true);
  await page.close();
});

test('mobile navigation closes with Escape and traps focus without leaving content inert', async () => {
  const page = await openPage({ viewport: { width: 390, height: 844 } });
  await page.locator('#burger').click();
  assert.equal(await page.locator('#burger').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('main').evaluate(el => el.inert), true);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id === 'burger' || Boolean(document.activeElement.closest('#mobileMenu'))), true);
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#mobileMenu').isVisible(), false);
  assert.equal(await page.locator('main').evaluate(el => el.inert), false);
  assert.equal(await page.locator('#burger').evaluate(el => document.activeElement === el), true);
  await page.locator('#burger').click();
  await page.locator('#mobileMenu a[href="#workflow"]').click();
  assert.equal(await page.locator('#mobileMenu').isVisible(), false);
  assert.equal(await page.locator('main').evaluate(el => el.inert), false);
  await page.close();
});

test('video pixels move, crossfade loops, manual pause works and leaving the hero stops playback', { timeout: 30000 }, async () => {
  const page = await openPage();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).some(video => video.readyState >= 2 && video.currentTime > 0.2 && !video.paused));
  async function pixels() {
    return page.evaluate(() => {
      const video = Array.from(document.querySelectorAll('video')).find(v => !v.paused);
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
      const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 64, 32);
      return Array.from(ctx.getImageData(0, 0, 64, 32).data);
    });
  }
  const first = await pixels();
  assert.ok(first.some((v, i) => i % 4 !== 3 && v > 40), 'Video should contain visible color');
  await page.waitForTimeout(650);
  assert.notDeepEqual(await pixels(), first);
  await page.waitForFunction(() => document.getElementById('bgVideoB').currentTime > 0.08 && !document.getElementById('bgVideoA').paused && !document.getElementById('bgVideoB').paused, null, { timeout: 12000 });
  await page.locator('#motionToggle').click();
  assert.equal(await page.locator('video').evaluateAll(videos => videos.every(video => video.paused)), true);
  const pausedTimes = await page.locator('video').evaluateAll(videos => videos.map(video => video.currentTime));
  await page.waitForTimeout(300);
  assert.deepEqual(await page.locator('video').evaluateAll(videos => videos.map(video => video.currentTime)), pausedTimes);
  await page.locator('#motionToggle').click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).some(video => !video.paused));
  await page.evaluate(() => window.scrollTo({ top: document.querySelector('.hero').offsetHeight, behavior: 'instant' }));
  await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).every(video => video.paused));
  assert.equal(await page.locator('.bg').evaluate(el => Number(el.style.getPropertyValue('--scene-opacity'))), 0);
  await page.screenshot({ path: path.join(artifacts, 'hero-to-product.png') });
  await page.close();
});

test('reduced motion avoids video requests and runtime preference changes pause playback', async () => {
  const page = await openPage({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('video').evaluateAll(videos => videos.every(video => video.paused && !video.currentSrc)), true);
  await page.screenshot({ path: path.join(artifacts, 'reduced-motion.png') });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).some(video => !video.paused && video.currentTime > 0));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.getElementById('motionToggle').disabled);
  assert.equal(await page.locator('video').evaluateAll(videos => videos.every(video => video.paused)), true);
  await page.close();
});

test('failed media and blocked preference storage retain readable content', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    Storage.prototype.getItem = function () { throw new DOMException('Blocked', 'SecurityError'); };
    Storage.prototype.setItem = function () { throw new DOMException('Blocked', 'SecurityError'); };
  });
  await page.route('**/*.mp4', route => route.abort());
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#localeToggle').click();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await page.locator('h1').isVisible(), true);
  await page.locator('.bg-still').evaluate(img => img.decode());
  assert.equal(await page.locator('.bg-still').isVisible(), true);
  await page.screenshot({ path: path.join(artifacts, 'media-fallback-mobile.png') });
  await page.close();
});

test('English and Chinese fit desktop, mobile, short and zoom-equivalent viewports', { timeout: 60000 }, async () => {
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 720, height: 450 }]) {
    const page = await openPage({ viewport, reducedMotion: 'reduce' });
    for (const language of ['en', 'zh']) {
      if (language === 'zh') await page.locator('#localeToggle').click();
      const overflow = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        return Array.from(document.querySelectorAll('main h1, main h2, main p, button, .hero-stats, .product-panel:not([hidden])')).filter(el => {
          if (!el.getClientRects().length) return false;
          const rect = el.getBoundingClientRect();
          return rect.left < -1 || rect.right > viewport + 1 || el.scrollWidth > el.clientWidth + 2;
        }).map(el => ({ tag: el.tagName, text: el.textContent.slice(0, 60), class: el.className }));
      });
      assert.deepEqual(overflow, [], viewport.width + 'px ' + language + ' overflow');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      if (viewport.height >= 720) {
        const next = await page.locator('#product').boundingBox();
        assert.ok(next.y < viewport.height, 'The next section should be hinted in the first viewport');
      }
      await page.screenshot({ path: path.join(artifacts, viewport.width + '-' + viewport.height + '-' + language + '.png'), fullPage: true });
    }
    await page.close();
  }
});
