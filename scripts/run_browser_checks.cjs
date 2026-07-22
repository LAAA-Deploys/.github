#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium, webkit } = require('playwright');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const siteRoot = path.resolve(argument('--site', process.cwd()));
const outputDir = path.resolve(argument('--output', path.join(process.cwd(), 'quality-artifacts')));
const quick = process.argv.includes('--quick');
const contract = JSON.parse(fs.readFileSync(path.join(siteRoot, '.laaa-marketing.json'), 'utf8'));
const entrypoint = contract.entrypoint || 'index.html';
const entrypointUrl = '/' + entrypoint.split(path.sep).join('/').replace(/^\/+/, '');
const failures = [];
const results = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function contentType(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function createServer() {
  return http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const relative = pathname === '/' ? entrypoint : pathname.replace(/^\/+/, '');
      const target = path.resolve(siteRoot, relative);
      if (target !== siteRoot && !target.startsWith(siteRoot + path.sep)) throw new Error('Path traversal');
      if (!fs.statSync(target).isFile()) throw new Error('Not a file');
      response.writeHead(200, { 'Content-Type': contentType(target), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(target).pipe(response);
    } catch (_) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
}

async function inspect(browser, baseUrl, width, height, options = {}) {
  const key = `${options.browser || 'chromium'}-${width}x${height}${options.suffix || ''}`;
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: options.reducedMotion || 'no-preference',
    forcedColors: options.forcedColors || 'none',
    isMobile: Boolean(options.isMobile),
    hasTouch: Boolean(options.hasTouch),
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const runtimeErrors = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(baseUrl).origin) route.continue();
    else route.abort('blockedbyclient');
  });
  page.on('console', message => { if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', request => runtimeErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    if (document.fonts) await document.fonts.ready;
    document.querySelectorAll('img[loading="lazy"]').forEach(image => { image.loading = 'eager'; });
    for (let y = 0; y < document.documentElement.scrollHeight; y += Math.max(300, window.innerHeight * .75)) {
      window.scrollTo(0, y);
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(resolve => setTimeout(resolve, 100));
    await Promise.all(Array.from(document.images, image => image.decode().catch(() => undefined)));
    window.scrollTo(0, 0);
  });

  const audit = await page.evaluate(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const controls = Array.from(document.querySelectorAll('button,.button,[data-laaa-control],nav a,.source-links a,.mobile-cta a'))
      .filter(visible)
      .map(element => {
        const rect = element.getBoundingClientRect();
        return { name: element.getAttribute('aria-label') || element.textContent.trim().replace(/\s+/g, ' '), width: rect.width, height: rect.height };
      });
    const clipped = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,a,button,b,span,li'))
      .filter(visible)
      .filter(element => !element.classList.contains('sr-only') && !element.closest('[data-laaa-scroll-region]'))
      .filter(element => {
        const style = getComputedStyle(element);
        return /(hidden|clip)/.test(`${style.overflow}${style.overflowX}${style.overflowY}`) &&
          (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
      })
      .map(element => `${element.tagName.toLowerCase()}.${element.className || ''}:${element.textContent.trim().slice(0, 50)}`);
    const heroContent = document.querySelector('[data-laaa-hero-content]');
    const heroKpis = document.querySelector('[data-laaa-hero-kpis]');
    let heroCollision = 0;
    if (heroContent && heroKpis) {
      const contentRects = Array.from(heroContent.children).filter(visible).map(child => child.getBoundingClientRect());
      const fallback = heroContent.getBoundingClientRect();
      const a = contentRects.length ? {
        left: Math.min(...contentRects.map(rect => rect.left)),
        right: Math.max(...contentRects.map(rect => rect.right)),
        top: Math.min(...contentRects.map(rect => rect.top)),
        bottom: Math.max(...contentRects.map(rect => rect.bottom)),
      } : fallback;
      const b = heroKpis.getBoundingClientRect();
      heroCollision = Math.max(0, Math.min(a.right,b.right)-Math.max(a.left,b.left)) * Math.max(0, Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
    }
    const tables = Array.from(document.querySelectorAll('table')).map(table => {
      const region = table.closest('[data-laaa-scroll-region]');
      const overflows = region ? region.scrollWidth > region.clientWidth + 1 : table.scrollWidth > table.clientWidth + 1;
      const firstCell = table.querySelector('th:first-child,td:first-child');
      return {
        overflows,
        hasRegion: Boolean(region),
        focusable: Boolean(region && region.getAttribute('tabindex') === '0'),
        labelled: Boolean(region && (region.getAttribute('aria-label') || region.getAttribute('aria-labelledby'))),
        cue: Boolean(region && region.parentElement.querySelector('[data-laaa-scroll-cue]')),
        sticky: Boolean(firstCell && getComputedStyle(firstCell).position === 'sticky'),
      };
    });
    const parseColor = value => {
      const match = value.match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;
      const parts = match[1].split(/[, ]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const luminance = color => {
      const channel = value => { const normalized = value / 255; return normalized <= .03928 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4; };
      return .2126 * channel(color.r) + .7152 * channel(color.g) + .0722 * channel(color.b);
    };
    const ratio = (a, b) => { const l1 = luminance(a); const l2 = luminance(b); return (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05); };
    const contrastFailures = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,a,button,li,td,th,span,b'))
      .filter(visible)
      .filter(element => !element.classList.contains('sr-only') && !element.closest('[data-laaa-over-image]'))
      .filter(element => Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()))
      .map(element => {
        const style = getComputedStyle(element);
        let ancestor = element;
        let background = null;
        let hasImageBackground = false;
        while (ancestor) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (ancestorStyle.backgroundImage !== 'none') hasImageBackground = true;
          const candidate = parseColor(ancestorStyle.backgroundColor);
          if (candidate && candidate.a >= .95) { background = candidate; break; }
          ancestor = ancestor.parentElement;
        }
        if (hasImageBackground || !background) return null;
        const foreground = parseColor(style.color);
        if (!foreground) return null;
        const fontSize = parseFloat(style.fontSize);
        const fontWeight = parseInt(style.fontWeight, 10) || 400;
        const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
        const actual = ratio(foreground, background);
        const required = large ? 3 : 4.5;
        return actual + .01 < required ? `${element.tagName.toLowerCase()}.${element.className || ''} ${actual.toFixed(2)}:${required}` : null;
      })
      .filter(Boolean);
    const images = Array.from(document.images).map(image => ({ src: image.getAttribute('src'), complete: image.complete, naturalWidth: image.naturalWidth }));
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      controls,
      clipped,
      heroCollision,
      tables,
      contrastFailures,
      images,
      activeExternalScripts: Array.from(document.scripts).filter(script => script.src && new URL(script.src).origin !== location.origin).map(script => script.src),
    };
  });

  check(audit.overflow <= 1, `${key}: document-level horizontal overflow ${audit.overflow}px`);
  check(audit.heroCollision <= 1, `${key}: hero content collides with KPI strip`);
  audit.controls.forEach(control => check(control.width >= 44 && control.height >= 44, `${key}: control below 44px "${control.name}" ${control.width.toFixed(1)}x${control.height.toFixed(1)}`));
  check(audit.clipped.length === 0, `${key}: clipped text ${audit.clipped.join(', ')}`);
  audit.images.forEach(image => check(image.complete && image.naturalWidth > 0, `${key}: broken image ${image.src}`));
  audit.tables.forEach((table, index) => {
    if (!table.overflows) return;
    check(table.hasRegion && table.focusable && table.labelled, `${key}: overflowing table ${index + 1} is not a labelled keyboard region`);
    check(table.cue, `${key}: overflowing table ${index + 1} lacks a visible cue`);
    if (width <= 620) check(table.sticky, `${key}: overflowing table ${index + 1} lacks a sticky identifying column`);
  });
  check(audit.contrastFailures.length === 0, `${key}: WCAG AA contrast failures ${audit.contrastFailures.join(', ')}`);
  check(audit.activeExternalScripts.length === 0, `${key}: external scripts are not permitted: ${audit.activeExternalScripts.join(', ')}`);
  check(runtimeErrors.length === 0, `${key}: runtime errors ${runtimeErrors.join('; ')}`);

  if (options.menuTest) {
    const toggle = page.locator('[data-laaa-menu-toggle]');
    const menu = page.locator('[data-laaa-menu]');
    check(await toggle.count() === 1 && await menu.count() === 1, `${key}: standardized menu hooks are missing`);
    if (await toggle.count() === 1 && await menu.count() === 1) {
      await toggle.click();
      check(await toggle.getAttribute('aria-expanded') === 'true', `${key}: menu does not set aria-expanded=true`);
      check(/close/i.test(await toggle.textContent()) || /close/i.test(await toggle.getAttribute('aria-label') || ''), `${key}: open menu has no Close accessible name`);
      check(await page.evaluate(() => document.activeElement === document.querySelector('[data-laaa-menu] a')), `${key}: menu does not focus its first link`);
      await page.keyboard.press('Escape');
      check(await toggle.getAttribute('aria-expanded') === 'false', `${key}: Escape does not close menu`);
      check(await page.evaluate(() => document.activeElement === document.querySelector('[data-laaa-menu-toggle]')), `${key}: Escape does not restore toggle focus`);
    }
  }

  if (options.screenshot) {
    fs.mkdirSync(outputDir, { recursive: true });
    await page.screenshot({ path: path.join(outputDir, `${key}.png`), fullPage: true });
  }
  results.push({ key, overflow: audit.overflow, controls: audit.controls.length, tables: audit.tables.length, runtimeErrors: runtimeErrors.length });
  await context.close();
}

async function main() {
  if (!fs.existsSync(path.join(siteRoot, '.laaa-marketing.json'))) throw new Error(`Missing ${path.join(siteRoot, '.laaa-marketing.json')}`);
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}${entrypointUrl}`;
  try {
    const chrome = await chromium.launch({ headless: true });
    const matrix = quick ? [[320,850],[390,844]] : [[320,850],[360,800],[390,844],[428,926],[768,1024],[844,390],[900,900],[901,900],[1440,900],[720,900]];
    for (const [width,height] of matrix) {
      await inspect(chrome, baseUrl, width, height, { browser: 'chromium', menuTest: width === 390 && height === 844, screenshot: !quick && [[320,850],[390,844],[844,390],[1440,900]].some(pair => pair[0] === width && pair[1] === height), suffix: width === 720 ? '-200-percent-zoom-equivalent' : '' });
    }
    if (!quick) {
      await inspect(chrome, baseUrl, 390, 844, { browser: 'chromium', reducedMotion: 'reduce', suffix: '-reduced-motion' });
      await inspect(chrome, baseUrl, 390, 844, { browser: 'chromium', forcedColors: 'active', suffix: '-forced-colors' });
      await inspect(chrome, baseUrl, 360, 800, { browser: 'chromium', isMobile: true, hasTouch: true, suffix: '-android-emulation' });
    }
    await chrome.close();
    if (!quick) {
      const safari = await webkit.launch({ headless: true });
      await inspect(safari, baseUrl, 390, 844, { browser: 'webkit', isMobile: true, hasTouch: true, suffix: '-ios-emulation', menuTest: true });
      await safari.close();
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'browser-results.json'), JSON.stringify({ passed: failures.length === 0, runs: results, failures }, null, 2) + '\n');
  if (failures.length) {
    console.error(`MARKETING BROWSER QUALITY FAILED (${failures.length})`);
    failures.forEach(failure => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(`MARKETING BROWSER QUALITY PASSED (${results.length} runs)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
