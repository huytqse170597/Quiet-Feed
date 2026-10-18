"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { connect } = require("./popup-sizing-test");
const root = path.resolve(__dirname, "../..");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "quiet-feed-style-audit-"));
  const server = spawn(process.execPath, [path.join(__dirname, "popup-test-server.js"), "4197"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const serverReady = new Promise((resolve, reject) => {
    server.stdout.once("data", resolve); server.once("error", reject);
    server.once("exit", (code) => { if (code) reject(new Error(`Preview server exited: ${code}`)); });
  });
  const chrome = spawn(process.env.QF_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    ["--headless=new", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${path.join(output, "profile")}`, "about:blank"],
    { windowsHide: true, stdio: "ignore" });
  let browser, page;
  const findings = [];
  try {
    await serverReady;
    const portFile = path.join(output, "profile/DevToolsActivePort");
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await wait(100);
    const [port, endpoint] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    browser = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    const { targetId } = await browser.call("Target.createTarget", { url: "about:blank" });
    page = await connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    const evaluate = async (expression) => {
      const result = await page.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    async function inspect(name, screenshot = false) {
      const issues = await evaluate(`(()=>{
        const issues=[];
        const tokens=getComputedStyle(document.documentElement);
        const rgb=(hex)=>hex.trim().replace('#','').match(/../g).map(v=>parseInt(v,16)/255);
        const luminance=(color)=>rgb(color).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
        const token=(name)=>tokens.getPropertyValue(name).trim();
        if(!matchMedia('(forced-colors: active)').matches) {
          for(const [label,fg,bg] of [
            ['Muted text',token('--muted'),token('--canvas')],
            ['Secondary text',token('--text-secondary'),token('--surface-1')],
            ['Primary button','#ffffff',token('--accent')],
            ['Links',token('--link'),token('--surface-1')]
          ]) {
            const a=luminance(fg),b=luminance(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
            if(ratio<4.5)issues.push(label+' contrast '+ratio.toFixed(2));
          }
          for(const badge of document.querySelectorAll('.filter-log-badge')) {
            const parse=color=>color.match(/[\\d.]+/g).map(Number);
            const bg=parse(getComputedStyle(badge).backgroundColor);
            const base=rgb(token('--surface-1')).map(v=>v*255);
            const effective=bg.slice(0,3).map((v,i)=>v*(bg[3]??1)+base[i]*(1-(bg[3]??1)));
            const lumRgb=values=>values.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
            const a=lumRgb(parse(getComputedStyle(badge).color)),b=lumRgb(effective);
            const ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
            if(ratio<4.5)issues.push(badge.textContent+' badge contrast '+ratio.toFixed(2));
          }
        }
        if(document.documentElement.scrollWidth>innerWidth+1) issues.push('Document overflows horizontally');
        for(const element of document.querySelectorAll('button,input:not([type=checkbox]),.section,.download-card,.stats>div,.stats strong,.custom-rules__form')){
          const r=element.getBoundingClientRect(),s=getComputedStyle(element);
          if(!r.width||!r.height||s.visibility==='hidden'||element.closest('[hidden]'))continue;
          if(r.left < -1 || r.right > innerWidth+1) issues.push(element.id||element.className||element.tagName);
        }
        return issues;
      })()`);
      if (issues.length) findings.push({ name, issues });
      if (screenshot) {
        const { cssContentSize } = await page.call("Page.getLayoutMetrics");
        const shot = await page.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 3200), scale: 1 } });
        fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(shot.data, "base64"));
      }
    }
    for (const surface of ["options", "download"]) {
      for (const width of [320, 380, 768, 1440]) {
        for (const theme of ["light", "dark"]) {
          await page.call("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: false });
          await page.call("Page.navigate", { url: `http://127.0.0.1:4197/preview/${surface}.html${surface === "download" ? "#12345678-1234-4234-8234-123456789abc" : ""}` });
          await wait(180);
          await evaluate(`document.documentElement.dataset.theme='${theme}'`);
          if (surface === "options") {
            await evaluate(`document.querySelector('#stat-reels').textContent='123456789012345'; document.querySelector('#new-rule-input').value='a'.repeat(200)`);
            await evaluate(`chrome.storage.local.set({quietFeedLog:['sponsored','reels','custom','suggested'].map(category=>({ts:Date.now(),category,text:'Long post title '.repeat(30),author:'Long author '.repeat(5)}))})`);
          } else {
            await evaluate(`document.querySelector('#filename').textContent='Long-video-title-'.repeat(20)+'.mp4';document.querySelector('#status').textContent='Combining video and audio locally…'`);
          }
          await inspect(`${surface}-${width}-${theme}`, width === 320 || (width === 1440 && theme === "light"));
          if(surface === "download") {
            for(const state of ['complete','error','cancelled']) {
              await evaluate(`document.body.dataset.state='${state}';document.querySelectorAll('.actions>*').forEach(e=>e.hidden=false)`);
              await inspect(`${surface}-${width}-${theme}-${state}`);
            }
          } else {
            await evaluate(`document.querySelector('#reload-alert').hidden=false;document.querySelector('#reload-copy').textContent='Reload Facebook to apply your updated settings.'`);
            await inspect(`${surface}-${width}-${theme}-reload`);
          }
        }
      }
    }
    await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 580, deviceScaleFactor: 1, mobile: false });
    await page.call("Page.navigate", { url: "http://127.0.0.1:4197/preview/popup.html" });
    await wait(200);
    for (const theme of ["light", "dark"]) {
      await evaluate(`document.documentElement.dataset.theme='${theme}'`);
      for (const tab of ["feed", "distractions", "privacy"]) {
        await evaluate(`document.querySelector('#tab-${tab}').click();window.scrollTo(0,0)`);
        await inspect(`popup-${tab}-${theme}`, true);
        const count = await evaluate("document.querySelectorAll('.feature-info').length");
        for(let index=0;index<count;index++) {
          await evaluate(`document.querySelectorAll('.feature-info')[${index}].focus()`);
          await wait(140);
          const tooltipIssue = await evaluate(`(()=>{const info=document.querySelectorAll('.feature-info')[${index}];const r=info.querySelector('.feature-tooltip').getBoundingClientRect();return r.left < 0||r.right > innerWidth||r.top<0||r.bottom>innerHeight})()`);
          if (tooltipIssue) findings.push({ name: `popup-${tab}-${theme}`, issues: [`Tooltip ${index} outside viewport`] });
        }
      }
    }
    await page.call("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    await inspect("popup-forced-colors", true);
    await page.call("Emulation.setEmulatedMedia", { features: [] });
    await page.call("Page.navigate", { url: "http://127.0.0.1:4197/src/popup/popup-test.html" });
    for (let i = 0; i < 100; i++) {
      if (await evaluate("['passed','failed'].includes(document.documentElement.dataset.testStatus)")) break;
      await wait(100);
    }
    console.log("Popup interactions:", await evaluate("document.documentElement.dataset.testStatus"));
    if(await evaluate("document.documentElement.dataset.testStatus") !== 'passed') findings.push({name:'Popup interactions',issues:['Browser suite failed']});
    await page.call("Emulation.setDeviceMetricsOverride", { width: 320, height: 740, deviceScaleFactor: 1, mobile: false });
    await page.call("Page.navigate", { url: "http://127.0.0.1:4197/tests/browser/responsive-test.html" });
    for(let i=0;i<130;i++) {
      if(await evaluate("['passed','failed'].includes(document.documentElement.dataset.responsiveStatus)")) break;
      await wait(100);
    }
    if(await evaluate("document.documentElement.dataset.responsiveStatus") !== 'passed') findings.push({name:'Facebook responsive controls',issues:[await evaluate("document.querySelector('#results').textContent")]});
    const pageHooks=fs.readFileSync(path.join(root,'src/page-hook.js'),'utf8');
    await evaluate(`(${pageHooks.slice(pageHooks.indexOf('function installPageStyle()'),pageHooks.indexOf('function incrementCounter('))})()`);
    await evaluate(`(()=>{
      const gallery=document.createElement('section');gallery.id='style-gallery';
      gallery.innerHTML='<div class="qf-placeholder"><span>Filtered sponsored post with a long description that should wrap inside the feed.</span><button class="qf-show-button">Show post</button></div><div class="qf-removed-placeholder"><span>Removed suggested content</span><button class="qf-removed-btn">Show post</button></div>';
      document.body.prepend(gallery);
    })()`);
    for(const theme of ['light','dark']) {
      await evaluate(`responsiveListeners.forEach(listener=>listener({quietFeedTheme:{newValue:'${theme}'}},'local'))`);
      const background = await evaluate("getComputedStyle(document.querySelector('#style-gallery .qf-placeholder')).backgroundColor");
      if(background !== (theme==='light'?'rgb(255, 255, 255)':'rgb(36, 37, 38)'))findings.push({name:'Facebook theme '+theme,issues:[background]});
      const screenshot=await page.call('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(output,`facebook-${theme}.png`),Buffer.from(screenshot.data,'base64'));
    }
    console.log(JSON.stringify({ output, findings }, null, 2));
    fs.writeFileSync(path.join(output, "findings.json"), JSON.stringify(findings, null, 2));
    if (findings.length) process.exitCode = 1;
  } finally {
    page?.socket.close();
    if (browser) { await browser.call("Browser.close").catch(() => {}); browser.socket.close(); }
    if (chrome.exitCode === null) chrome.kill();
    server.kill();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
