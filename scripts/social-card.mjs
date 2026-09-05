import {chromium} from '@playwright/test';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1200,height:630},deviceScaleFactor:1});
await page.goto('http://localhost:4173/docs/redesign/social-card.html');
await page.screenshot({path:'og.png'});
await browser.close();
