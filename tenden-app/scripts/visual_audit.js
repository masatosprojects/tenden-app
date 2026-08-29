const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_URL = process.env.TENDEN_TEST_URL || 'http://localhost:8085/';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUTPUT_DIR = path.join(os.tmpdir(), 'tenden-visual-audit');
const VIEWPORTS = [
  { name: 'small', width: 320, height: 568, isMobile: true, hasTouch: true },
  { name: 'standard', width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: 'wide', width: 430, height: 932, isMobile: true, hasTouch: true },
  { name: 'landscape', width: 844, height: 390, isMobile: true, hasTouch: true },
  { name: 'desktop', width: 1366, height: 900, isMobile: false, hasTouch: false },
];
const VIEWPORT_FILTER = (process.env.TENDEN_VIEWPORTS || '').split(',').map((value) => value.trim()).filter(Boolean);
const ACTIVE_VIEWPORTS = VIEWPORT_FILTER.length ? VIEWPORTS.filter((viewport) => VIEWPORT_FILTER.includes(viewport.name)) : VIEWPORTS;

function safeName(value) {
  return value.replace(/[^a-z0-9_-]+/gi, '-');
}

async function inspectLayout(page, label) {
  return page.evaluate((auditLabel) => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className.slice(0, 140) : null,
    });
    const horizontalOverflow = [];
    document.querySelectorAll('body *').forEach((el) => {
      if (!visible(el)) return;
      if (el.closest('#map, .leaflet-container') || ['svg', 'g', 'path'].includes(el.tagName.toLowerCase())) return;
      const r = el.getBoundingClientRect();
      if (r.left < -2 || r.right > vw + 2) {
        horizontalOverflow.push({ ...describe(el), left: r.left, right: r.right, width: r.width });
      }
    });
    const activeOverlays = Array.from(document.querySelectorAll('.overlay.active')).map((overlay) => {
      const dialog = overlay.querySelector('.dialog, .quake-sheet, .route-bottom-sheet');
      const r = (dialog || overlay).getBoundingClientRect();
      return {
        ...describe(overlay),
        content: dialog ? describe(dialog) : null,
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
        outsideViewport: r.left < -2 || r.right > vw + 2 || r.top < -2 || r.bottom > vh + 2,
        scrollHeight: dialog?.scrollHeight || null,
        clientHeight: dialog?.clientHeight || null,
      };
    });
    const smallTargets = [];
    document.querySelectorAll('button, a, input, select, textarea, [role="button"]').forEach((el) => {
      if (!visible(el)) return;
      if (el.closest('#map, .leaflet-container')) return;
      const r = el.getBoundingClientRect();
      if ((r.width < 40 || r.height < 40) && !el.closest('.leaflet-control')) {
        smallTargets.push({ ...describe(el), width: r.width, height: r.height, text: (el.textContent || '').trim().slice(0, 60) });
      }
    });
    return {
      label: auditLabel,
      viewport: { width: vw, height: vh },
      bodyClass: document.body.className,
      horizontalOverflow: horizontalOverflow.slice(0, 50),
      activeOverlays,
      smallTargets: smallTargets.slice(0, 80),
    };
  }, label);
}

async function capture(page, viewportName, label, records) {
  const filename = `${viewportName}-${safeName(label)}.png`;
  const filepath = path.join(OUTPUT_DIR, filename);
  await page.screenshot({ path: filepath, animations: 'disabled' });
  records.push({ ...(await inspectLayout(page, `${viewportName}:${label}`)), screenshot: filepath });
}

async function activate(locator, hasTouch) {
  if (hasTouch) await locator.tap();
  else await locator.click();
}

async function openFromDock(page, trunk, selector, hasTouch) {
  await activate(page.locator(`.trunk-item[data-trunk="${trunk}"]`), hasTouch);
  await page.waitForTimeout(520);
  await activate(page.locator(selector), hasTouch);
  await page.waitForTimeout(420);
}

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const records = [];
  const errors = [];
  const consoleErrors = [];

  for (const viewport of ACTIVE_VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
      geolocation: { latitude: 35.3084, longitude: 139.5504 },
      permissions: ['geolocation'],
    });
    await context.addInitScript(() => {
      localStorage.setItem('tenden-tos-agreed', '1');
      localStorage.setItem('tenden-location-explained', 'true');
      localStorage.setItem('tenden-pwa-ver', 'v7.6');
      localStorage.setItem('tenden-demo-seen', 'true');
      sessionStorage.setItem('sn-dismissed', '1');
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push({ viewport: viewport.name, message: message.text() });
      }
    });
    page.on('pageerror', (error) => errors.push({
      viewport: viewport.name,
      message: error.message,
      stack: error.stack || '',
    }));
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    if (await page.locator('#btn-demo-skip-0').isVisible().catch(() => false)) {
      await activate(page.locator('#btn-demo-skip-0'), viewport.hasTouch);
      await page.waitForTimeout(500);
    }
    if (await page.locator('#btn-onboarding-ok').isVisible().catch(() => false)) {
      await activate(page.locator('#btn-onboarding-ok'), viewport.hasTouch);
      await page.waitForTimeout(500);
    }
    if (await page.locator('#btn-startup-notice-close').isVisible().catch(() => false)) {
      await activate(page.locator('#btn-startup-notice-close'), viewport.hasTouch);
      await page.waitForTimeout(350);
    }
    // The notice payload can arrive after the initial close check; keep visual
    // navigation audits deterministic once startup UI has been exercised.
    await page.locator('#startup-notice').evaluate((element) => element.classList.add('hidden')).catch(() => {});

    await capture(page, viewport.name, 'main', records);
    await activate(page.locator('.trunk-item[data-trunk="learn"]'), viewport.hasTouch);
    await page.waitForTimeout(500);
    await capture(page, viewport.name, 'dock-learn', records);
    await activate(page.locator('#dock-sub-close'), viewport.hasTouch);
    await page.waitForTimeout(300);

    const overlayCases = [
      ['settings', 'more', '.dock-sub-panel[data-trunk="more"] [data-trigger="btn-settings"]', '#btn-settings-close'],
      ['about', 'more', '#btn-open-about', '#btn-about-close'],
      ['layers', 'map', '.dock-sub-panel[data-trunk="map"] [data-trigger="btn-toggle-layers"]', '#btn-layers-close'],
      ['quake', 'quake', '#dock-quake-earthquake', '#btn-quake-close'],
      ['report-choice', 'community', '#dock-report-card', '#btn-report-choice-close'],
      ['ai-guide', 'learn', '#btn-open-ai-guide', '#btn-ai-guide-close'],
      ['guide', 'learn', '#btn-open-guide', '#btn-guide-close'],
      ['app-share', 'community', '#dock-app-share', '#btn-app-share-close'],
    ];
    for (const [label, trunk, trigger, closer] of overlayCases) {
      await openFromDock(page, trunk, trigger, viewport.hasTouch);
      await capture(page, viewport.name, label, records);
      if (await page.locator(closer).isVisible().catch(() => false)) await activate(page.locator(closer), viewport.hasTouch);
      await page.waitForTimeout(420);
    }
    await context.close();
  }

  const report = { outputDir: OUTPUT_DIR, records, errors, consoleErrors };
  const reportPath = path.join(OUTPUT_DIR, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    reportPath,
    screenshotCount: records.length,
    pageErrors: errors,
    consoleErrors,
    overflowCases: records.filter((r) => r.horizontalOverflow.length).map((r) => ({ label: r.label, items: r.horizontalOverflow.length })),
    outsideOverlayCases: records.flatMap((r) => r.activeOverlays.filter((o) => o.outsideViewport).map((o) => ({ label: r.label, overlay: o.id, rect: o.rect }))),
    smallTargetCases: records.map((r) => ({ label: r.label, targets: r.smallTargets })).filter((r) => r.targets.length),
  }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
