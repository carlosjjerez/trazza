// Render an HTML file to PDF using the installed Chrome (puppeteer-core).
const puppeteer = require('/home/user/trazza/app/node_modules/puppeteer-core');
const path = require('path');
const CHROME = '/root/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome';
(async () => {
  const inHtml = process.argv[2], outPdf = process.argv[3];
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(inHtml), { waitUntil: 'networkidle0' });
  await page.pdf({ path: outPdf, format: 'A4', printBackground: true,
    margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: '<div style="width:100%;font-size:8px;color:#888;padding:0 12mm;text-align:right;">Página <span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
  await browser.close();
  console.log('PDF OK ->', outPdf);
})().catch(e => { console.error(e); process.exit(1); });
