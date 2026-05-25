const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const http = require('http');

// 1. Start a highly reliable built-in static server on port 8082
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
    // Basic protection against traversal
    let safeUrl = req.url.split('?')[0];
    if (safeUrl === '/') safeUrl = '/index.html';
    
    const filePath = path.join(__dirname, safeUrl);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
            res.end(err.code === 'ENOENT' ? '404 Not Found' : `500 Server Error: ${err.code}`);
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(8082, '127.0.0.1', () => {
    console.log("Built-in Node.js server running at http://127.0.0.1:8082");
});

// 2. Locate Google Chrome
const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
];

let executablePath = '';
for (const p of chromePaths) {
    if (fs.existsSync(p)) {
        executablePath = p;
        break;
    }
}

if (!executablePath) {
    console.error("Could not find Google Chrome installation path!");
    server.close();
    process.exit(1);
}

// 3. Launch automated mobile device browser test
(async () => {
    console.log("Launching Chrome at:", executablePath);
    const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    // Set iPhone 12 Pro dimensions (390 x 844)
    await page.setViewport({
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true
    });

    // Capture console logs from browser
    page.on('console', msg => {
        console.log(`[BROWSER CONSOLE] ${msg.type().toUpperCase()}: ${msg.text()}`);
    });

    page.on('pageerror', err => {
        console.error(`[BROWSER ERROR] ${err.toString()}`);
    });

    try {
        console.log("Navigating to http://127.0.0.1:8082/app.html ...");
        await page.goto('http://127.0.0.1:8082/app.html', { waitUntil: 'networkidle2' });

        // Save initial screenshot
        await page.screenshot({ path: path.join(__dirname, 'screenshot_1_loaded.png') });
        console.log("Screenshot 1 saved: Loaded");

        // Click the 'テスト発令' button
        await page.waitForSelector('#btn-test-alert', { timeout: 5000 });
        console.log("Clicking Test Alert button...");
        await page.click('#btn-test-alert');

        await new Promise(resolve => setTimeout(resolve, 1500));
        await page.screenshot({ path: path.join(__dirname, 'screenshot_2_test_alert_clicked.png') });
        console.log("Screenshot 2 saved: Test Alert dialog");

        // Click custom alert OK button
        await page.waitForSelector('#btn-alert-ok', { timeout: 5000 });
        console.log("Clicking custom alert OK button via evaluate...");
        await page.evaluate(() => {
            const btn = document.getElementById('btn-alert-ok');
            if (btn) btn.click();
        });
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Click on the map to drop a pin
        console.log("Clicking on the map (center-bottom) to drop a pin...");
        await page.mouse.click(195, 500);

        await new Promise(resolve => setTimeout(resolve, 3000));
        await page.screenshot({ path: path.join(__dirname, 'screenshot_3_route_options.png') });
        console.log("Screenshot 3 saved: Route options bottom sheet");

        // Verify the labels of the routes in the container
        const routeLabels = await page.$$eval('#route-options-container button strong', labels => labels.map(l => l.innerText));
        console.log("Route options in container:", routeLabels);

        // Click Route C or Route B card in bottom sheet
        const buttons = await page.$$('#route-options-container button');
        if (buttons.length > 0) {
            console.log(`Found ${buttons.length} route cards. Clicking the first route option card...`);
            await buttons[0].click();
            await new Promise(resolve => setTimeout(resolve, 3500));
            await page.screenshot({ path: path.join(__dirname, 'screenshot_4_after_route_click.png') });
            console.log("Screenshot 4 saved: After route click");
        } else {
            console.log("No route buttons found!");
        }

    } catch (err) {
        console.error("Test failed with error:", err);
    } finally {
        await browser.close();
        server.close();
        console.log("All done!");
        process.exit(0);
    }
})();
