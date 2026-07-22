#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const validator = path.join(root, 'scripts', 'validate_marketing_site.py');
const browserHarness = path.join(root, 'scripts', 'run_browser_checks.cjs');
const manifest = path.join(root, 'branding', 'logo_manifest.json');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laaa-quality-canaries-'));
const failures = [];

const cleanHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Clean fixture</title><link rel="stylesheet" href="styles.css"><script defer src="site.js"></script></head><body>
<header><a class="wordmark" href="#overview"><span data-laaa-brand-slot="header" data-logo-variant="blue" data-brand-context="light"><img src="brand/LAAA_Team_Blue.png" alt="LAAA Team"></span><span>Offering Memorandum</span></a><button data-laaa-menu-toggle aria-expanded="false" aria-controls="nav"><span data-laaa-menu-label>Open navigation</span></button><nav id="nav" data-laaa-menu><a href="#overview">Overview</a></nav></header>
<main id="overview"><section class="hero"><div data-laaa-hero-content><h1>Clean marketing fixture</h1><a class="button" href="#facts">Review facts</a></div><div data-laaa-hero-kpis><div><b>3</b><span>Units</span></div><div><b>100%</b><span>Occupied</span></div></div></section><section id="facts"><h2>Facts</h2><p>Readable content on a light background.</p></section></main>
<footer><span data-laaa-brand-slot="footer" data-logo-variant="white" data-brand-context="dark"><img src="brand/LAAA_Team_White.png" alt="LAAA Team"></span><p>Confidential marketing review.</p></footer></body></html>`;
const cleanCss = `*{box-sizing:border-box}body{margin:0;color:#18212a;background:#fbfaf7;font:16px Arial,sans-serif}header{min-height:74px;padding:10px 20px;display:flex;align-items:center;justify-content:space-between}.wordmark{min-height:44px;display:flex;align-items:center;gap:12px;color:#122d49}.wordmark img{width:130px}button,.button,nav a{min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:8px 12px}.hero{min-height:500px;padding:100px 20px 0;background:#122d49;color:#fff;display:flex;flex-direction:column;justify-content:flex-end}.hero .button{color:#fff}.hero>[data-laaa-hero-content]{padding:20px 0}.hero>[data-laaa-hero-kpis]{display:grid;grid-template-columns:repeat(2,1fr);border-top:1px solid #fff}.hero>[data-laaa-hero-kpis]>div{padding:20px}main section:not(.hero){padding:60px 20px}footer{padding:40px 20px;background:#081a2a;color:#fff}footer img{width:180px}@media(max-width:900px){nav{display:none;position:absolute;top:74px;right:0;background:#fff;padding:12px}nav.open{display:block}nav a{color:#122d49}}@media(min-width:901px){button{display:none}}`;
const cleanJs = `(()=>{const b=document.querySelector('[data-laaa-menu-toggle]');const n=document.querySelector('[data-laaa-menu]');const l=document.querySelector('[data-laaa-menu-label]');const close=()=>{b.setAttribute('aria-expanded','false');l.textContent='Open navigation';n.classList.remove('open');b.focus()};b.addEventListener('click',()=>{b.setAttribute('aria-expanded','true');l.textContent='Close navigation';n.classList.add('open');n.querySelector('a').focus()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&b.getAttribute('aria-expanded')==='true')close()})})();`;

function makeFixture(name, mutation = () => {}) {
  const site = path.join(tempRoot, name);
  fs.mkdirSync(path.join(site, 'brand'), { recursive: true });
  fs.copyFileSync(path.join(root, 'branding', 'logos', 'LAAA_Team_Blue.png'), path.join(site, 'brand', 'LAAA_Team_Blue.png'));
  fs.copyFileSync(path.join(root, 'branding', 'logos', 'LAAA_Team_White.png'), path.join(site, 'brand', 'LAAA_Team_White.png'));
  fs.writeFileSync(path.join(site, '.laaa-marketing.json'), JSON.stringify({ schemaVersion: 1, deliverable: 'om', entrypoint: 'index.html', requireNoindex: true }, null, 2));
  fs.writeFileSync(path.join(site, 'index.html'), cleanHtml);
  fs.writeFileSync(path.join(site, 'styles.css'), cleanCss);
  fs.writeFileSync(path.join(site, 'site.js'), cleanJs);
  mutation(site);
  return site;
}

function runStatic(site) {
  return spawnSync(process.env.PYTHON || 'python', [validator, '--site', site, '--manifest', manifest], { encoding: 'utf8' });
}

function runBrowser(site) {
  return spawnSync(process.execPath, [browserHarness, '--site', site, '--output', path.join(site, 'artifacts'), '--quick'], { encoding: 'utf8' });
}

function expect(name, result, shouldPass) {
  const passed = result.status === 0;
  if (passed !== shouldPass) failures.push(`${name}: expected ${shouldPass ? 'PASS' : 'FAIL'}, exit=${result.status}\n${result.stdout}\n${result.stderr}`);
  else console.log(`${name}: ${passed ? 'PASS' : 'EXPECTED FAILURE'}`);
}

function moveToNestedEntrypoint(site) {
  const nested = path.join(site, 'dist');
  fs.mkdirSync(nested);
  for (const name of ['index.html', 'styles.css', 'site.js', 'brand']) {
    fs.renameSync(path.join(site, name), path.join(nested, name));
  }
  fs.writeFileSync(path.join(site, '.laaa-marketing.json'), JSON.stringify({ schemaVersion: 1, deliverable: 'om', entrypoint: 'dist/index.html', requireNoindex: true }, null, 2));
}

try {
  const clean = makeFixture('clean');
  expect('clean static', runStatic(clean), true);
  expect('clean browser', runBrowser(clean), true);

  const rootRelative = makeFixture('root-relative-assets', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('src="brand/', 'src="/brand/').replace('href="styles.css"', 'href="/styles.css"').replace('src="site.js"', 'src="/site.js"'));
  });
  expect('root-relative assets static', runStatic(rootRelative), true);
  expect('root-relative assets browser', runBrowser(rootRelative), true);

  const reversedNoindex = makeFixture('reversed-noindex', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<meta name="robots" content="noindex,nofollow">', '<meta content="nofollow, noindex" name="robots"><meta name="robots" content="max-image-preview:large">'));
  });
  expect('order-independent cumulative noindex', runStatic(reversedNoindex), true);

  const httpEquivNoindex = makeFixture('http-equiv-noindex', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('name="robots"', 'http-equiv="robots"'));
  });
  expect('http-equiv noindex', runStatic(httpEquivNoindex), true);

  const sameElementSlot = makeFixture('same-element-brand-slot', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('class="wordmark"', '').replace('<span data-laaa-brand-slot="header"', '<span class="wordmark" data-laaa-brand-slot="header"'));
  });
  expect('same-element wordmark slot', runStatic(sameElementSlot), true);

  const unrelatedWordmarkSubstring = makeFixture('unrelated-wordmark-substring', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<main id="overview">', '<main id="overview"><p class="swordmark">Ordinary prose</p>'));
  });
  expect('unrelated wordmark substring', runStatic(unrelatedWordmarkSubstring), true);

  const nestedEntrypoint = makeFixture('nested-entrypoint', moveToNestedEntrypoint);
  expect('nested entrypoint static', runStatic(nestedEntrypoint), true);
  expect('nested entrypoint browser', runBrowser(nestedEntrypoint), true);

  const leadingSlashEntrypoint = makeFixture('leading-slash-entrypoint', site => {
    fs.writeFileSync(path.join(site, '.laaa-marketing.json'), JSON.stringify({ schemaVersion: 1, deliverable: 'om', entrypoint: '/index.html', requireNoindex: true }, null, 2));
  });
  expect('leading slash entrypoint static', runStatic(leadingSlashEntrypoint), false);
  expect('leading slash entrypoint browser', runBrowser(leadingSlashEntrypoint), false);

  const traversingEntrypoint = makeFixture('traversing-entrypoint', site => {
    fs.writeFileSync(path.join(site, '.laaa-marketing.json'), JSON.stringify({ schemaVersion: 1, deliverable: 'om', entrypoint: 'dist/../index.html', requireNoindex: true }, null, 2));
  });
  expect('traversing entrypoint static', runStatic(traversingEntrypoint), false);
  expect('traversing entrypoint browser', runBrowser(traversingEntrypoint), false);

  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'laaa-marketing-quality.yml'), 'utf8');
  if (!/^\s{2}pull_request:\s*$/m.test(workflow) || !/^\s{2}merge_group:\s*$/m.test(workflow)) failures.push('ruleset workflow: missing supported pull_request/merge_group triggers');
  else console.log('ruleset workflow triggers: PASS');

  const altered = makeFixture('altered-logo', site => {
    fs.appendFileSync(path.join(site, 'brand', 'LAAA_Team_Blue.png'), Buffer.from([0]));
  });
  expect('altered logo', runStatic(altered), false);

  const outsideSlotLogo = makeFixture('outside-slot-logo', site => {
    const disguised = path.join(site, 'brand', 'mark.png');
    fs.copyFileSync(path.join(root, 'branding', 'logos', 'LAAA_Team_Blue.png'), disguised);
    fs.appendFileSync(disguised, Buffer.from([0]));
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('</main>', '<img src="brand/mark.png" alt="Graphic"></main>'));
  });
  expect('disguised logo outside slot', runStatic(outsideSlotLogo), false);

  const slotSrcset = makeFixture('brand-slot-srcset', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('src="brand/LAAA_Team_Blue.png" alt="LAAA Team"', 'src="brand/LAAA_Team_Blue.png" srcset="brand/LAAA_Team_White.png 2x" alt="LAAA Team"'));
  });
  expect('brand slot srcset', runStatic(slotSrcset), false);

  const styled = makeFixture('styled-wordmark', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<span data-laaa-brand-slot="header" data-logo-variant="blue" data-brand-context="light"><img src="brand/LAAA_Team_Blue.png" alt="LAAA Team"></span>', '<span data-laaa-brand-slot="header" data-logo-variant="blue" data-brand-context="light"><b style="font-family:serif">LAAA</b></span>'));
  });
  expect('styled-text wordmark', runStatic(styled), false);

  const nestedSlotBypass = makeFixture('nested-slot-bypass', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<img src="brand/LAAA_Team_Blue.png" alt="LAAA Team">', '<span><img src="brand/LAAA_Team_Blue.png" alt="LAAA Team"></span><svg aria-hidden="true"></svg>'));
  });
  expect('nested brand-slot bypass', runStatic(nestedSlotBypass), false);

  const embeddedSlotBypass = makeFixture('embedded-slot-bypass', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<img src="brand/LAAA_Team_Blue.png" alt="LAAA Team">', '<img src="brand/LAAA_Team_Blue.png" alt="LAAA Team"><object data="brand/LAAA_Team_White.png"></object>'));
  });
  expect('embedded brand-slot bypass', runStatic(embeddedSlotBypass), false);

  const missing = makeFixture('missing-asset', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('</main>', '<img src="missing.jpg" alt="Missing canary"></main>'));
  });
  expect('missing asset', runStatic(missing), false);

  const extraHtml = makeFixture('extra-html-route', site => {
    fs.writeFileSync(path.join(site, 'bypass.html'), '<!doctype html><html><body><h1>LAAA styled bypass</h1></body></html>');
  });
  expect('extra HTML route', runStatic(extraHtml), false);

  const extraXhtml = makeFixture('extra-xhtml-route', site => {
    fs.writeFileSync(path.join(site, 'bypass.xhtml'), '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Bypass</h1></body></html>');
  });
  expect('extra XHTML route', runStatic(extraXhtml), false);

  const outbound = makeFixture('outbound-request', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('</main>', '<img src="https://example.invalid/external.png" alt="Outbound canary"></main>'));
  });
  expect('outbound browser request', runBrowser(outbound), false);

  const missingCssAsset = makeFixture('missing-css-asset', site => {
    fs.appendFileSync(path.join(site, 'styles.css'), 'body{background-image:url(missing-background.png)}');
  });
  expect('missing CSS asset response', runBrowser(missingCssAsset), false);

  const missingHeroHook = makeFixture('missing-hero-hook', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(' data-laaa-hero-kpis', ''));
  });
  expect('missing hero KPI hook static', runStatic(missingHeroHook), false);
  expect('missing hero KPI hook browser', runBrowser(missingHeroHook), false);

  const collision = makeFixture('hero-collision', site => {
    fs.appendFileSync(path.join(site, 'styles.css'), '@media(max-width:620px){.hero{position:relative}.hero>[data-laaa-hero-kpis]{position:absolute;left:20px;right:20px;bottom:40px}.hero>[data-laaa-hero-content]{padding-bottom:60px}}');
  });
  expect('hero collision', runBrowser(collision), false);

  const overflow = makeFixture('narrow-overflow', site => {
    const file = path.join(site, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('</main>', '<div style="width:420px">Overflow canary</div></main>'));
  });
  expect('320px overflow', runBrowser(overflow), false);

  const brokenMenu = makeFixture('broken-menu', site => {
    fs.writeFileSync(path.join(site, 'site.js'), '');
  });
  expect('broken menu semantics', runBrowser(brokenMenu), false);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`CANARY SUITE FAILED (${failures.length})`);
  failures.forEach(failure => console.error(failure));
  process.exit(1);
}
console.log('CANARY SUITE PASSED (clean controls + twenty expected failures)');
