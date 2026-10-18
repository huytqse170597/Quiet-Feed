"use strict";

// Exercise Chrome's actual action popup sizing, without a fixed page viewport.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const executable = process.env.QF_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  return { socket, call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  } };
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "quiet-feed-popup-sizing-"));
  const chrome = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "about:blank"],
  { windowsHide: true, stdio: "ignore" });
  let browser;
  const connections = [];
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
    const [port, endpoint] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    browser = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    const { id } = await browser.call("Extensions.loadUnpacked", { path: root });
    async function targets() { return (await browser.call("Target.getTargets")).targetInfos; }
    let worker;
    for (let i = 0; i < 60; i++) {
      worker = (await targets()).find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${id}/`));
      if (worker) break;
      await sleep(100);
    }
    assert.ok(worker, "Extension service worker started");
    const workerConnection = await connect(`ws://127.0.0.1:${port}/devtools/page/${worker.targetId}`);
    connections.push(workerConnection);
    await workerConnection.call("Runtime.enable");
    for (let i = 0; i < 60; i++) {
      const ready = await workerConnection.call("Runtime.evaluate", { expression: "typeof chrome !== 'undefined' && !!chrome.action", returnByValue: true });
      if (ready.result.value) break;
      await sleep(100);
    }
    const opened = await workerConnection.call("Runtime.evaluate", {
      expression: "chrome.action.openPopup()", awaitPromise: true, returnByValue: true,
    });
    assert.ok(!opened.exceptionDetails, JSON.stringify(opened.exceptionDetails));
    let popup;
    for (let i = 0; i < 60; i++) {
      popup = (await targets()).find((target) => target.url === `chrome-extension://${id}/src/popup/popup.html`);
      if (popup) break;
      await sleep(100);
    }
    assert.ok(popup, "Actual browser action popup opened");
    const page = await connect(`ws://127.0.0.1:${port}/devtools/page/${popup.targetId}`);
    connections.push(page);
    await sleep(500);
    const result = await page.call("Runtime.evaluate", { expression: `JSON.stringify({
      innerWidth, rootWidth: document.documentElement.getBoundingClientRect().width,
      bodyWidth: document.body.getBoundingClientRect().width,
      scrollWidth: document.documentElement.scrollWidth, height: innerHeight,
      rows: document.querySelectorAll('.feature-row').length
    })`, returnByValue: true });
    const geometry = JSON.parse(result.result.value);
    console.log("Actual extension popup:", geometry);
    assert.ok(geometry.innerWidth >= 380 && geometry.innerWidth <= 400,
      "Chrome must allocate the intended popup width, allowing a native scrollbar");
    assert.equal(geometry.rootWidth, 380);
    assert.ok(geometry.bodyWidth >= 365);
    assert.ok(geometry.scrollWidth <= 380, "No horizontal overflow");
    assert.ok(geometry.rows > 0, "Popup rendered real extension settings");
    for(const theme of ['light','dark']) {
      await page.call('Runtime.evaluate',{expression:`chrome.storage.local.set({quietFeedTheme:'${theme}'})`,awaitPromise:true});
      for(const tab of ['feed','distractions','privacy']) {
        await page.call('Runtime.evaluate',{expression:`document.querySelector('#tab-${tab}').click();window.scrollTo(0,0)`});
        const measured=await page.call('Runtime.evaluate',{expression:`(()=>{
          const root=document.documentElement;return {
            width:root.getBoundingClientRect().width,overflow:root.scrollWidth>innerWidth,
            rows:document.querySelectorAll('.feature-row').length,
            theme:root.dataset.theme,
            doubleScroll:document.body.scrollHeight>document.body.clientHeight&&getComputedStyle(document.body).overflowY==='auto'
          };
        })()`,returnByValue:true});
        const value=measured.result.value;
        assert.equal(value.width,380);
        assert.equal(value.overflow,false);
        assert.ok(value.rows>0);
        assert.equal(value.theme,theme);
        assert.equal(value.doubleScroll,false);
        const tooltips=await page.call('Runtime.evaluate',{expression:`document.querySelectorAll('.feature-info').length`,returnByValue:true});
        for(let index=0;index<tooltips.result.value;index++) {
          await page.call('Runtime.evaluate',{expression:`document.querySelectorAll('.feature-info')[${index}].focus()`});
          await sleep(130);
          const bounds=await page.call('Runtime.evaluate',{expression:`(()=>{
            const r=document.querySelectorAll('.feature-info')[${index}].querySelector('.feature-tooltip').getBoundingClientRect();
            return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;
          })()`,returnByValue:true});
          assert.equal(bounds.result.value,true,`Actual popup tooltip fits: ${theme}/${tab}/${index}`);
        }
        await page.call('Runtime.evaluate',{expression:'document.activeElement.blur();window.scrollTo(0,0)'});
        const shot=await page.call('Page.captureScreenshot',{format:'png'});
        fs.writeFileSync(path.join(profile,`popup-${tab}-${theme}.png`),Buffer.from(shot.data,'base64'));
      }
    }
    console.log('Actual popup: all three categories, light/dark themes, and single-scroll layout passed.');
    const screenshot = await page.call("Page.captureScreenshot", { format: "png" });
    const screenshotPath = path.join(profile, "popup.png");
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    console.log("Screenshot:", screenshotPath);
    console.log("Actual extension popup sizing passed.");
  } finally {
    for (const connection of connections) connection.socket.close();
    if (browser) { await browser.call("Browser.close").catch(() => {}); browser.socket.close(); }
    if (chrome.exitCode === null) chrome.kill();
  }
}
module.exports = { connect };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
