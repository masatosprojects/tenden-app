const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_URL = process.env.TENDEN_TEST_URL || 'http://localhost:8085/';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUTPUT_DIR = path.join(os.tmpdir(), 'tenden-onboarding-audit');
const VIEWPORTS = [
  { name: 'small', width: 320, height: 568 },
  { name: 'standard', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
];

async function inspect(page, label) {
  return page.evaluate((name) => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const active = document.querySelector('.demo-step.active');
    const interactive = Array.from(active?.querySelectorAll('button, a') || []).filter((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    }).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.id || null, width: r.width, height: r.height, bottom: r.bottom, outside: r.left < 0 || r.right > vw || r.top < 0 || r.bottom > vh };
    });
    const stepRect = active?.getBoundingClientRect();
    const agent = document.querySelector('#onboarding-overlay #tenden-agent');
    const agentRect = agent?.getBoundingClientRect();
    return {
      label: name,
      activeStep: active?.id || null,
      stepRect: stepRect ? { left: stepRect.left, top: stepRect.top, right: stepRect.right, bottom: stepRect.bottom, width: stepRect.width, height: stepRect.height } : null,
      agentRect: agentRect ? { left: agentRect.left, top: agentRect.top, right: agentRect.right, bottom: agentRect.bottom, width: agentRect.width, height: agentRect.height } : null,
      interactive,
      bodyScroll: { width: document.body.scrollWidth, height: document.body.scrollHeight, vw, vh },
    };
  }, label);
}

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const records = [];
  const errors = [];
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript(() => {
      localStorage.setItem('tenden-tos-agreed', '1');
      localStorage.setItem('tenden-location-explained', 'true');
      localStorage.setItem('tenden-pwa-ver', 'v7.9');
      localStorage.removeItem('tenden-demo-seen');
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push({ viewport: viewport.name, message: error.message }));
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5200);
    const actions = [null, '#btn-demo-next-0', '#btn-demo-next-1', '#btn-demo-next-2'];
    for (let step = 0; step < actions.length; step += 1) {
      if (actions[step]) {
        await page.locator(actions[step]).tap({ timeout: 5000 });
        await page.waitForTimeout(500);
      }
      const label = `${viewport.name}-step-${step}`;
      const screenshot = path.join(OUTPUT_DIR, `${label}.png`);
      await page.screenshot({ path: screenshot, animations: 'disabled' });
      records.push({ ...(await inspect(page, label)), screenshot });
    }
    await context.close();
  }
  const reportPath = path.join(OUTPUT_DIR, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ records, errors }, null, 2));
  console.log(JSON.stringify({
    reportPath,
    screenshotCount: records.length,
    errors,
    outsideControls: records.flatMap((r) => r.interactive.filter((i) => i.outside).map((i) => ({ label: r.label, id: i.id }))),
    bodyOverflow: records.filter((r) => r.bodyScroll.width > r.bodyScroll.vw || r.bodyScroll.height > r.bodyScroll.vh).map((r) => ({ label: r.label, bodyScroll: r.bodyScroll })),
  }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
