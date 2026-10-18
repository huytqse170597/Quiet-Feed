"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const port = Number(process.argv[2]) || 4173;
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

http
  .createServer((request, response) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (pathname === "/preview/download.html") {
      const html = fs.readFileSync(path.join(root, "src/download/download.html"), "utf8")
        .replace("<head>", '<head>\n<base href="/src/download/">')
        .replace('<script src="../shared/ui-components.js"></script>',
          '<script src="/tests/browser/chrome-mock.js"></script>\n<script src="/tests/browser/download-preview.js"></script>\n<script src="../shared/ui-components.js"></script>');
      response.writeHead(200, { "Content-Type": contentTypes[".html"] });
      response.end(html);
      return;
    }
    const previewPages = {
      "/preview/options.html": path.join(root, "src", "options", "options.html"),
      "/preview/popup.html": path.join(root, "src", "popup", "popup.html"),
    };
    if (previewPages[pathname]) {
      const baseHref = pathname.includes("options") ? "/src/options/" : "/src/popup/";
      const html = fs
        .readFileSync(previewPages[pathname], "utf8")
        .replace("<head>", `<head>\n    <base href="${baseHref}">`)
        .replace(
          '<script src="../shared/features.js"></script>',
          '<script src="/tests/browser/chrome-mock.js"></script>\n    <script src="/src/shared/features.js"></script>',
        )
        .replace('src="../../icons/', 'src="/icons/');
      response.writeHead(200, { "Content-Type": contentTypes[".html"] });
      response.end(html);
      return;
    }

    if (pathname === "/src/popup/popup-test.html") {
      const popupPath = path.join(root, "src", "popup", "popup.html");
      const html = fs
        .readFileSync(popupPath, "utf8")
        .replace(
          '<script src="../shared/features.js"></script>',
          '<script src="../../tests/browser/chrome-mock.js"></script>\n    <script src="../shared/features.js"></script>',
        )
        .replace(
          '<script src="popup.js"></script>',
          '<script src="popup.js"></script>\n    <script src="../../tests/browser/popup-test-runner.js"></script>',
        );
      response.writeHead(200, { "Content-Type": contentTypes[".html"] });
      response.end(html);
      return;
    }

    const target = path.resolve(root, `.${pathname}`);
    const relative = path.relative(root, target);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !fs.existsSync(target) ||
      !fs.statSync(target).isFile()
    ) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(target)] || "application/octet-stream",
    });
    fs.createReadStream(target).pipe(response);
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`Popup browser tests: http://127.0.0.1:${port}/src/popup/popup-test.html`);
  });
