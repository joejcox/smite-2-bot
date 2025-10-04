// commands/captureTierlist.js (ESM)
import puppeteer from 'puppeteer';

const TIERLIST_URL = 'https://smitebrain.com/tier-list';
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

export default async function captureTierList() {
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
        ],
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });

        await page.goto(TIERLIST_URL, { waitUntil: 'networkidle2', timeout: 90_000 });
        // Extra settle (replaces waitForTimeout)
        await delay(1200);

        // Trigger lazy-load by scrolling
        await page.evaluate(async () => {
            const el = document.scrollingElement || document.documentElement;
            let y = 0;
            await new Promise((res) => {
                (function step() {
                    y += 800;
                    el.scrollTo(0, y);
                    if (y >= el.scrollHeight - el.clientHeight) res();
                    else setTimeout(step, 60);
                })();
            });
        });

        // Hide sticky bits if present
        await page.addStyleTag({
            content: `
        header, .navbar, footer, [role="banner"], #ad-top-banner, [data-testid*="cookie"] {
          display: none !important;
        }
      `,
        });

        // Wait for main content to exist
        await page.waitForSelector('main', { timeout: 20_000 });

        // Try several selectors (class order can vary with Tailwind/hydration)
        const candidates = [
            'main div.mx-auto.flex.max-w-7xl.flex-col',
            "main div[class*='mx-auto'][class*='max-w-7xl']",
            'main .max-w-7xl',
            'main article',
            'main section',
        ];

        let handle = null;
        for (const sel of candidates) {
            handle = await page.$(sel);
            if (handle) break;
        }

        // If not found, locate a heading with “tier” and climb
        if (!handle) {
            const headings = await page.$x(
                "//h1|//h2|//h3" +
                "[contains(translate(normalize-space(string())," +
                " 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'tier')]"
            );

            if (headings.length) {
                const h = headings[0];
                handle = await (
                    await h.evaluateHandle((node) => {
                        function hasClass(el, cls) {
                            return el.classList && el.classList.contains(cls);
                        }
                        let p = node;
                        while (p && p.nodeType === 1) {
                            if (
                                p.matches?.('article, section, main') ||
                                hasClass(p, 'mx-auto') ||
                                /\bmax-w-7xl\b/.test(p.className || '')
                            ) {
                                return p;
                            }
                            p = p.parentElement;
                        }
                        return node.ownerDocument.querySelector('main') || node.ownerDocument.body;
                    })
                ).asElement();
            }
        }

        let png;
        if (handle) {
            await handle.evaluate((node) =>
                node.scrollIntoView({ block: 'start', behavior: 'instant' }) // note: behavior, not behaviour
            );
            const box = await handle.boundingBox();
            png =
                box && box.width > 200 && box.height > 200
                    ? await handle.screenshot({ type: 'png' })
                    : await page.screenshot({ type: 'png', fullPage: true });
        } else {
            // Absolute fallback to guarantee a reply
            png = await page.screenshot({ type: 'png', fullPage: true });
        }

        await page.close();
        return png;
    } finally {
        await browser.close();
    }
}
