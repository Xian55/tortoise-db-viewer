import puppeteer from "puppeteer-core";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = (process.env.SMOKE_BASE || "https://xian55.github.io/tortoise-db-viewer/") + "?item=7909";

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("console", (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => console.log(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await new Promise((r) => setTimeout(r, 12000));
const html = await page.$eval("#app", (e) => e.innerHTML).catch(() => "(no #app)");
console.log("\n#app innerHTML (first 600 chars):\n" + html.slice(0, 600));
await browser.close();
