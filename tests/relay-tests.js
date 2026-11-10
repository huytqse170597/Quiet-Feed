"use strict";

// Facebook no longer exposes window.___rs and its Relay records are plain
// objects. These tests keep the replacement ___sf lookup honest without
// needing a live Facebook session.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "relay-reader.js"), "utf8");

function createRelay(records) {
  const storeSource = {
    get(id) {
      return records[id] || null;
    },
  };
  const environment = {
    getStore() {
      return { getSource: () => storeSource };
    },
  };
  const fiber = { memoizedProps: { environment }, child: null, sibling: null };
  const rootNode = { __reactContainer$test: fiber };
  const document = {
    querySelectorAll() {
      return [rootNode];
    },
  };
  const context = vm.createContext({ document, console });
  vm.runInContext(source, context, { filename: "relay-reader.js" });
  return { relay: context.QuietFeedRelay, sf: context.___sf, context };
}

const records = {
  feed1: {
    __id: "feed1",
    __typename: "FeedUnit",
    sponsored_data: { __ref: "ad1" },
  },
  ad1: { __id: "ad1", __typename: "Ad", ad_id: "123" },
  video1: {
    __id: "video1",
    __typename: "Video",
    video_delivery_response: { __ref: "delivery1" },
  },
  delivery1: {
    __id: "delivery1",
    progressive_urls: { __refs: ["p1", "p2"] },
    dash_manifests: { __refs: ["d1"] },
  },
  p1: {
    __id: "p1",
    progressive_url: "https://video.xx.fbcdn.net/sd.mp4",
    metadata: { __ref: "m1" },
  },
  p2: {
    __id: "p2",
    progressive_url: "https://video.xx.fbcdn.net/hd.mp4",
    metadata: { __ref: "m2" },
  },
  m1: { __id: "m1", quality: "SD" },
  m2: { __id: "m2", quality: "HD" },
  d1: { __id: "d1", manifest_xml: "<MPD/>" },
  arg1: {
    __id: "arg1",
    'video_delivery_response(video_delivery_request:{"quality":"HD"})': { __ref: "d1" },
  },
};

const deliveryVariables = {
  $1: { video_delivery_request: { progressive_url_requests: [{ quality: "SD" }] } },
};

const { relay, sf, context } = createRelay(records);

assert.equal(relay.read("feed1", "^sponsored_data.ad_id"), "123");
assert.equal(sf("feed1", "^sponsored_data.ad_id"), "123");
assert.equal(
  relay.read({ __id: "feed1", sponsored_data: { __ref: "ad1" } }, "^sponsored_data.ad_id"),
  "123",
);
assert.equal(relay.read("ad1", "ad_id"), "123");

const progressive = relay.read(
  "video1",
  "^video_delivery_response{$1}.^^progressive_urls.*",
  deliveryVariables,
);
assert.equal(progressive.length, 2);
assert.equal(progressive[0].__id, "p1");
assert.equal(relay.read(progressive[0], "^metadata.quality"), "SD");
assert.equal(relay.read("video1", "^video_delivery_response{$1}.^^dash_manifests[0].manifest_xml", deliveryVariables), "<MPD/>");

// Arguments can arrive in a different key order; a single prefix match is still
// safe, while multiple ambiguous matches must not guess.
assert.equal(
  relay.read(
    "arg1",
    "^video_delivery_response{$1}",
    { $1: { video_delivery_request: { quality: "HD", extra: true } } },
  ).__id,
  "d1",
);

assert.equal(relay.read("missing", "anything"), undefined);
assert.equal(relay.read("feed1", ""), records.feed1);
assert.equal(relay.read("feed1", null), undefined);

// Facebook's legacy runtime assigns ___sf again when Relay initializes. The
// setter trap must keep the plain-record reader in place.
context.___sf = () => "legacy";
assert.equal(context.___sf, sf);
assert.equal(context.___sf("feed1", "^sponsored_data.ad_id"), "123");

console.log("Relay reader plain-record, linked, plural, argument, fiber, and override tests passed.");
