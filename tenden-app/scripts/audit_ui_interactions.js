const { chromium } = require('playwright');

const APP_URL = process.env.TENDEN_TEST_URL || 'http://localhost:8085/';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function visible(page, selector) {
  return page.locator(selector).evaluate((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  }).catch(() => false);
}

async function dismissIfVisible(page, selector) {
  if (await visible(page, selector)) await page.locator(selector).click();
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    geolocation: { latitude: 35.3084, longitude: 139.5504 },
    permissions: ['geolocation'],
  });
  await context.addInitScript(() => {
    localStorage.setItem('tenden-tos-agreed', '1');
    localStorage.setItem('tenden-location-explained', 'true');
  });

  const page = await context.newPage();
  const errors = [];
  const failedResources = [];
  page.on('pageerror', (error) => errors.push({ type: 'pageerror', message: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push({ type: 'console', message: message.text() });
  });
  page.on('requestfailed', (request) => {
    failedResources.push({ url: request.url(), error: request.failure()?.errorText || 'request failed' });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failedResources.push({ url: response.url(), status: response.status() });
  });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5200);

  for (const selector of ['#btn-demo-next-0', '#btn-demo-next-1', '#btn-demo-next-2', '#btn-demo-use-here']) {
    await page.locator(selector).click();
    await page.waitForTimeout(450);
  }
  await page.locator('#onboarding-overlay').waitFor({ state: 'hidden', timeout: 5000 });
  await page.waitForTimeout(800);
  await dismissIfVisible(page, '#btn-startup-notice-close');
  await dismissIfVisible(page, '#btn-error-ok');

  const results = [];
  for (const trunkId of ['evac', 'quake', 'map', 'community', 'learn', 'more']) {
    const selector = `.trunk-item[data-trunk="${trunkId}"]`;
    const hit = await page.locator(selector).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return {
        buttonRect: { x: r.x, y: r.y, width: r.width, height: r.height },
        topTag: top?.tagName || null,
        topId: top?.id || null,
        topClass: typeof top?.className === 'string' ? top.className : null,
        topInsideButton: !!(top && el.contains(top)),
      };
    });

    let clickError = null;
    try {
      await page.locator(selector).tap({ timeout: 3000 });
      await page.waitForTimeout(100);
    } catch (error) {
      clickError = error.message;
    }

    const state = await page.evaluate((id) => {
      const sheet = document.getElementById('dock-sub-sheet');
      const panel = document.querySelector(`.dock-sub-panel[data-trunk="${id}"]`);
      const trunk = document.querySelector(`.trunk-item[data-trunk="${id}"]`);
      const style = sheet ? getComputedStyle(sheet) : null;
      return {
        sheetHiddenClass: sheet?.classList.contains('hidden') ?? null,
        sheetAriaHidden: sheet?.getAttribute('aria-hidden') ?? null,
        sheetDisplay: style?.display ?? null,
        sheetOpacity: style?.opacity ?? null,
        sheetPointerEvents: style?.pointerEvents ?? null,
        panelHidden: panel?.hidden ?? null,
        trunkExpanded: trunk?.getAttribute('aria-expanded') ?? null,
      };
    }, trunkId);
    results.push({ trunkId, hit, clickError, state });
    await dismissIfVisible(page, '#dock-sub-close');
  }

  // Exercise one real action behind every primary category. This catches the
  // common failure mode where the trunk opens but its child controls were never wired.
  const actionCases = [
    { trunkId: 'evac', action: '#btn-real-mode', expected: '#real-mode-confirm', close: '#btn-real-cancel' },
    { trunkId: 'quake', action: '#dock-quake-tsunami', expected: '#quake-overlay', close: '#btn-quake-close' },
    { trunkId: 'map', action: '.dock-sub-panel[data-trunk="map"] [data-trigger="btn-toggle-layers"]', expected: '#layers-overlay', close: '#btn-layers-close' },
    { trunkId: 'community', action: '#dock-report-card', expected: '#report-choice-overlay', close: '#btn-report-choice-close' },
    { trunkId: 'learn', action: '#btn-open-ai-guide', expected: '#ai-guide-overlay', close: '#btn-ai-guide-close' },
    { trunkId: 'more', action: '#btn-open-about', expected: '#about-overlay', close: '#btn-about-close' },
  ];
  const actionResults = [];
  for (const test of actionCases) {
    let error = null;
    try {
      await page.locator(`.trunk-item[data-trunk="${test.trunkId}"]`).tap({ timeout: 3000 });
      await page.waitForTimeout(550);
      await page.locator(test.action).tap({ timeout: 3000 });
      await page.waitForTimeout(180);
      const opened = await visible(page, test.expected);
      actionResults.push({ ...test, opened });
      if (opened) {
        await page.locator(test.close).tap({ timeout: 3000 });
        await page.waitForTimeout(380);
      }
    } catch (caught) {
      error = caught.message;
      actionResults.push({ ...test, opened: false, error });
    }
    await dismissIfVisible(page, '#dock-sub-close');
  }

  const finalState = await page.evaluate(() => ({
    bodyClass: document.body.className,
    onboardingClass: document.getElementById('onboarding-overlay')?.className,
    visibleOverlays: Array.from(document.querySelectorAll('.overlay')).filter((el) => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    }).map((el) => ({ id: el.id, className: el.className, zIndex: getComputedStyle(el).zIndex })),
  }));

  console.log(JSON.stringify({ results, actionResults, errors, failedResources, finalState }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
