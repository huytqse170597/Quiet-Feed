// Facebook stopped exposing the Relay RecordSourceProxy as window.___rs, and
// Relay records are now plain objects instead of the old record API. This
// replaces the runtime's ___sf() lookup with one that can read records from a
// live Relay store source discovered through React fibers.
(function initializeQuietFeedRelayReader(global) {
  "use strict";

  if (global.___qfRelayReader) return;
  global.___qfRelayReader = true;

  const MAX_FIBERS = 30000;
  const SOURCE_RETRY_MS = 500;
  let recordSource = null;
  let sourceCheckedAt = 0;

  function getLegacySource() {
    const source = global.___rs;
    return source && typeof source.get === "function" ? source : null;
  }

  function findRecordSource() {
    const roots = document.querySelectorAll('[id^="mount_0_0"]');
    for (const root of roots) {
      const key = Object.keys(root).find((name) => name.startsWith("__reactContainer$"));
      if (!key) continue;
      const source = scanFiberTree(root[key]);
      if (source) return source;
    }
    return null;
  }

  function scanFiberTree(start) {
    if (!start) return null;
    const queue = [start];
    const seen = new Set();
    for (let index = 0; index < queue.length && seen.size < MAX_FIBERS; index++) {
      const fiber = queue[index];
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);

      const props = fiber.memoizedProps;
      if (props && typeof props === "object") {
        const environment = props.environment;
        if (environment && typeof environment.getStore === "function") {
          try {
            const store = environment.getStore();
            const source = typeof store?.getSource === "function" ? store.getSource() : null;
            if (source && typeof source.get === "function") return source;
          } catch {
            // Try the next component; some environments are partially torn down.
          }
        }
      }

      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    return null;
  }

  function getSource(force) {
    const legacy = getLegacySource();
    if (legacy) return legacy;
    const now = Date.now();
    if (recordSource) return recordSource;
    if (!force && now - sourceCheckedAt < SOURCE_RETRY_MS) return null;
    sourceCheckedAt = now;
    recordSource = findRecordSource();
    return recordSource;
  }

  function getRecord(id, force) {
    if (id == null) return null;
    if (typeof id === "object") return id;
    const key = String(id);
    const source = getSource(force);
    if (!source) return null;
    const record = source.get(key);
    if (record) return record;
    if (force) return null;
    // The page may have navigated and replaced its Relay store.
    recordSource = null;
    const refreshed = getSource(true);
    return refreshed ? refreshed.get(key) || null : null;
  }

  // Relay fields carrying arguments use keys such as
  // `video_delivery_response(video_delivery_request:{...})`.
  function fieldValue(record, name, args) {
    if (record == null) return undefined;
    if (name in Object(record)) return record[name];
    if (!args || typeof args !== "object") return undefined;
    const argString = Object.entries(args)
      .map(([key, value]) => `${key}:${JSON.stringify(value)}`)
      .join(",");
    const candidates = [`${name}(${argString})`, `${name}{${JSON.stringify(args)}}`];
    for (const candidate of candidates) {
      if (candidate in Object(record)) return record[candidate];
    }
    // Field argument ordering is not guaranteed by Relay. Only use a
    // prefix match when it is unambiguous.
    const matches = Object.keys(record).filter(
      (key) => key.startsWith(`${name}(`) || key.startsWith(`${name}{`),
    );
    return matches.length === 1 ? record[matches[0]] : undefined;
  }

  // Hook payloads often contain fragment objects with only a few fields and an
  // __id. Fall back to the full store record when the fragment lacks a field.
  function readField(record, name, args) {
    const direct = fieldValue(record, name, args);
    if (direct !== undefined) return direct;
    const id = record && typeof record === "object" ? record.__id : null;
    if (!id) return undefined;
    const full = getRecord(id);
    return full && full !== record ? fieldValue(full, name, args) : undefined;
  }

  function dereference(value, plural) {
    if (plural) {
      if (value && Array.isArray(value.__refs)) return value.__refs.map((ref) => getRecord(ref));
      if (Array.isArray(value)) return value.map((item) => dereference(item, false));
      return [];
    }
    if (value && typeof value === "object" && typeof value.__ref === "string") {
      return getRecord(value.__ref);
    }
    return value;
  }

  function parseSegment(segment, variables) {
    let plural = false;
    let linked = false;
    if (segment.startsWith("^^")) {
      plural = true;
      linked = true;
      segment = segment.slice(2);
    } else if (segment.startsWith("^")) {
      linked = true;
      segment = segment.slice(1);
    }

    let name = segment;
    let args;
    const brace = segment.indexOf("{");
    if (brace !== -1 && segment.endsWith("}")) {
      const token = segment.slice(brace + 1, -1);
      name = segment.slice(0, brace);
      args = variables && typeof variables === "object" ? variables[token] : undefined;
    }
    return { name, args, linked, plural };
  }

  function read(id, path, variables) {
    if (typeof path !== "string") return undefined;
    let value = getRecord(id);
    if (value == null) return undefined;

    const parts = path.replace(/\[(\d+)]/g, ".$1").split(".").filter(Boolean);
    for (const part of parts) {
      if (value == null) return undefined;
      if (part === "*") return value;
      if (/^\d+$/.test(part)) {
        value = value[Number(part)];
        continue;
      }

      const { name, args, linked, plural } = parseSegment(part, variables);
      value = readField(value, name, args);
      if (linked) value = dereference(value, plural);
    }
    return value;
  }

  // Keep the runtime's public name working for page-hook.js, video-page.js,
  // and any other Facebook page script that uses the same lookup. Facebook's
  // legacy runtime defines ___sf later, while its Relay module initializes, so
  // a plain assignment here would be overwritten. A setter trap keeps this
  // reader active for the lifetime of the page.
  try {
    Object.defineProperty(global, "___sf", {
      configurable: true,
      enumerable: true,
      get: () => read,
      set: () => {},
    });
  } catch {
    global.___sf = read;
  }
  global.QuietFeedRelay = Object.freeze({ read, getRecord, getSource });
})(globalThis);
