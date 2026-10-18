"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { connect } = require("./popup-sizing-test");
const root = path.resolve(__dirname, "../..");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (path.relative(root, file).startsWith("..") || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404); response.end(); return;
    }
    const ext = path.extname(file);
    response.setHeader("Content-Type", ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html" })[ext] || "application/octet-stream");
    let data = fs.readFileSync(file);
    if (ext === ".html" && url.searchParams.has("noBridge")) {
      data = data.toString().replace('<script src="../../src/video-page.js"></script>', "");
    }
    if (ext === ".html" && url.searchParams.has("noVideoHelper")) {
      data = data.toString().replace('<script src="../../src/shared/video.js"></script>', "");
    }
    response.end(data);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "quiet-feed-video-controls-"));
  const chrome = spawn(process.env.QF_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    ["--headless=new", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
    { windowsHide: true, stdio: "ignore" });
  let browser, page;
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await wait(100);
    const [port, endpoint] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    browser = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    const { targetId } = await browser.call("Target.createTarget", { url: "about:blank" });
    page = await connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    const scriptErrors=[];
    page.socket.addEventListener('message',({data})=>{
      const message=JSON.parse(String(data));
      if(message.method==='Runtime.exceptionThrown') scriptErrors.push(message.params.exceptionDetails);
    });
    await page.call('Runtime.enable');
    await page.call("Emulation.setDeviceMetricsOverride", { width: 420, height: 720, deviceScaleFactor: 1, mobile: false });
    const evaluate = async (expression) => {
      const result = await page.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    async function until(expression, timeout = 5000) {
      const deadline = Date.now() + timeout;
      while (!(await evaluate(expression))) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`);
        await wait(50);
      }
    }
    const trigger = `document.querySelector('[data-qf-video-control="button"]').shadowRoot.querySelector('button')`;
    const menu = `document.querySelector('[data-qf-video-control="menu"]').shadowRoot`;
    async function click(expression) {
      const box = await evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await page.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...box });
      await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...box });
    }
    await page.call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/tests/browser/video-test.html?noBridge=1` });
    await until(`!!document.querySelector('[data-qf-video-control="button"]')`);
    assert.equal(await evaluate(`Object.entries(fixtureVideoLayout).every(([id, before]) => {
      const after = document.getElementById(id).getBoundingClientRect();
      return after.top === before.top && after.height === before.height;
    })`), true, "Attaching download controls must not move or resize the player or caption");
    assert.equal(await evaluate(`document.querySelector('[data-qf-video-id]').getBoundingClientRect().height`), 0,
      "The video marker must not reserve a black row");
    async function checkRoundPosition(player = "document.querySelector('#fixture-player')") {
      await until(`(()=>{
        const a=(${trigger}).getBoundingClientRect(),b=(${player}).getBoundingClientRect();
        return Math.abs(b.right-a.right-8)<1.5&&Math.abs(a.top-b.top-8)<1.5;
      })()`);
      assert.equal(await evaluate(`(${trigger}).textContent`),'');
      assert.equal(await evaluate(`(${trigger}).getAttribute('aria-label')`),'Download video');
      assert.equal(await evaluate(`(()=>{const r=(${trigger}).getBoundingClientRect();return Math.abs(r.width-r.height)<1})()`),true);
      assert.equal(await evaluate(`getComputedStyle(${trigger}).borderRadius`),'50%');
    }
    await checkRoundPosition();
    console.log("Download overlay preserves player/caption geometry and reserves zero layout height.");
    await click(trigger);
    await until(`${menu}.querySelector('.retry') !== null`);
    assert.match(await evaluate(`${menu}.querySelector('.status').textContent`), /didn’t respond/);
    assert.equal(await evaluate(`${menu}.querySelector('.menu').getAttribute('aria-busy')`), "false");
    console.log("Missing page bridge leaves loading within three seconds and offers retry.");
    const emptyShot = await page.call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(profile, "unavailable.png"), Buffer.from(emptyShot.data, "base64"));
    // Restore the actual MAIN-world handler, then retry without closing the menu.
    await evaluate(fs.readFileSync(path.join(root, "src/video-page.js"), "utf8"));
    await click(`${menu}.querySelector('.retry')`);
    await until(`${menu}.querySelectorAll('.choice').length === 4`);
    assert.equal(await evaluate(`${menu}.querySelector('.retry') === null`), true);
    await click(`${menu}.querySelector('.choice')`);
    await until(`${menu}.querySelector('.status').textContent.includes('Download started')`);
    assert.match(await evaluate(`document.querySelector('#result').textContent`),
      /Trang thử nghiệm - Fixture video - 123 - SD\.mp4/);
    const screenshot = await page.call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(profile, "ready.png"), Buffer.from(screenshot.data, "base64"));
    await click(`${menu}.querySelector('.dismiss')`);
    assert.equal(await evaluate(`${trigger}.getAttribute('aria-expanded')`), "false");
    assert.equal(await evaluate(`document.querySelector('[data-qf-video-control="menu"]') === null`), true);
    console.log("Retry recovers SD/HD/DASH/audio choices; trusted download and close clicks pass.");
    for (const layout of ["flex", "grid"]) {
      await page.call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/tests/browser/video-test.html?layout=${layout}` });
      await until(`!!document.querySelector('[data-qf-video-control="button"]')`);
      assert.equal(await evaluate(`Object.entries(fixtureVideoLayout).every(([id,before])=>{
        const after=document.getElementById(id).getBoundingClientRect();return after.top===before.top&&after.height===before.height;
      })`), true, `${layout} gap layout remains unchanged by the download anchor`);
    }
    for(const width of [320,420,768]) {
      await page.call("Emulation.setDeviceMetricsOverride", {width,height:600,deviceScaleFactor:1,mobile:false});
      for(const theme of ['light','dark']) {
        await evaluate(`chrome.storage.local.set({quietFeedTheme:'${theme}'})`);
        await checkRoundPosition();
        await click(trigger);
        await until(`${menu}.querySelectorAll('.choice').length===4`);
        const box=await evaluate(`(()=>{const r=${menu}.querySelector('.menu').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`);
        assert.ok(box.left>=0&&box.right<=box.width&&box.top>=0&&box.bottom<=box.height,
          `Video menu remains in ${width}px viewport, ${theme}`);
        assert.equal(await evaluate(`getComputedStyle(${menu}.querySelector('.menu')).backgroundColor`),
          theme==='dark'?'rgb(36, 37, 38)':'rgb(255, 255, 255)');
        if(width===320) {
          const shot=await page.call('Page.captureScreenshot',{format:'png'});
          fs.writeFileSync(path.join(profile,`menu-${theme}-320.png`),Buffer.from(shot.data,'base64'));
        }
        await click(`${menu}.querySelector('.dismiss')`);
      }
    }
    await page.call('Network.enable');
    await page.call('Network.setBlockedURLs',{urls:['*://*.fbcdn.net/*']});
    await evaluate(`(()=>{
      const shell=document.querySelector('#fixture-player-shell');shell.style.display='block';
      const video=document.createElement('video');video.preload='none';video.src='https://video.fbcdn.net/fixture.mp4';
      video.style.cssText='display:block;width:100%;height:180px';shell.replaceChildren(video);
      const rect=video.getBoundingClientRect();window.directVideoBaseline={top:rect.top,height:rect.height};
    })()`);
    await until(`!!document.querySelector('[data-qf-video-control="anchor"] [data-qf-video-control="button"]')`);
    await checkRoundPosition("document.querySelector('video')");
    assert.equal(await evaluate(`(()=>{const r=document.querySelector('video').getBoundingClientRect();return r.top===directVideoBaseline.top&&r.height===directVideoBaseline.height})()`),true,
      'Direct video fallback also leaves player geometry unchanged');
    await click(trigger);
    await until(`${menu}.querySelectorAll('.choice').length===1`);
    assert.match(await evaluate(`${menu}.querySelector('.choice').textContent`),/Current file/);
    await evaluate(`(()=>{
      const shell=document.querySelector('#fixture-player-shell');shell.setAttribute('role','article');
      const heading=document.createElement('h3'), author=document.createElement('a');
      author.textContent='Nguyễn An';heading.append(author);shell.append(heading);
      const caption=document.createElement('div');caption.dataset.adPreview='message';
      caption.textContent='Chuyến đi Đà Lạt';shell.append(caption);
    })()`);
    await click(`${menu}.querySelector('.choice')`);
    await until(`${menu}.querySelector('.status').textContent.includes('Download started')`);
    assert.match(await evaluate(`document.querySelector('#result').textContent`),
      /Nguyễn An - Chuyến đi Đà Lạt\.mp4/);
    await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert.equal(await evaluate(`document.querySelector('[data-qf-video-control="menu"]')===null`),true);
    console.log('Flex/grid spacing, direct player layout, light/dark menus at 320/420/768px, and Escape passed.');
    await page.call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/tests/browser/video-test.html?noBridge=1&noVideoHelper=1`});
    await until("document.readyState==='complete' && !!document.querySelector('#fixture-player-shell')");
    assert.equal(await evaluate('typeof globalThis.QuietFeedVideo'),'undefined');
    await evaluate(`(()=>{
      const video=document.createElement('video');video.preload='none';video.src='https://video.fbcdn.net/helper-missing.mp4';
      video.style.cssText='display:block;width:100%;height:180px';
      document.querySelector('#fixture-player-shell').replaceChildren(video);
    })()`);
    await until(`!!document.querySelector('[data-qf-video-control="anchor"] [data-qf-video-control="button"]')`);
    await checkRoundPosition("document.querySelector('video')");
    await click(trigger);
    await until(`${menu}.querySelectorAll('.choice').length===1`);
    assert.match(await evaluate(`${menu}.querySelector('.choice').textContent`),/Current file/);
    assert.deepEqual(scriptErrors,[], 'No uncaught exception with the video helper absent at startup');
    console.log('Startup without QuietFeedVideo still supports the direct video control and download menu.');
    console.log("Screenshots:", profile);
  } finally {
    page?.socket.close();
    if (browser) { await browser.call("Browser.close").catch(() => {}); browser.socket.close(); }
    if (chrome.exitCode === null) chrome.kill();
    server.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
