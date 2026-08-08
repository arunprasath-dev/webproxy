/**
 * Proxy client bootstrap (v2).
 *
 * Injected synchronously at the top of <head> so it runs before any upstream
 * script. Rewrites URLs the browser would otherwise send to the upstream
 * origin so they route back through the proxy:
 *
 *   - API overrides: fetch, Request, XMLHttpRequest, WebSocket, EventSource,
 *     window.open, location (href/assign/replace), history pushState/replaceState,
 *     navigator.sendBeacon, Worker/SharedWorker (blob loader).
 *   - Synchronous IDL setter patches on element prototypes so JS-created /
 *     detached elements (new Image(); img.src = ...) are caught with no race.
 *   - A MutationObserver that rewrites URL attributes and inline style url()s on
 *     inserted/changed nodes (idempotent: proxied() passes proxy-origin URLs
 *     through unchanged, so a second pass is a no-op).
 *   - navigator.serviceWorker neutralized (a service worker would intercept the
 *     proxied requests and break the mapping).
 *
 * The proxy origin comes from the shim's data-origin (injected by the server);
 * the true upstream document URL comes from data-base. Both fall back to
 * window.location so the same script also works when served at /__bootstrap.js.
 *
 * ES5 (no modules, no arrow functions) so it runs in any modern browser and is
 * safe to inline: it never contains an HTML script-closer or an HTML comment
 * opener, so the parser cannot terminate the shim early or enter comment data.
 */
(function () {
  "use strict";
  if (window.__proxyBootstrap) return;
  window.__proxyBootstrap = true;

  // ---- origin / base ------------------------------------------------------
  // The shim element is in the DOM while this inline script executes, so
  // querySelector finds it synchronously (no need for document.currentScript).
  var shim = document.querySelector && document.querySelector("script[data-proxy-bootstrap]");
  var origin = (shim && shim.getAttribute("data-origin")) || window.location.origin;
  var dataBase = (shim && shim.getAttribute("data-base")) || window.location.href;

  var baseCache;
  function effectiveBase() {
    if (baseCache) return baseCache;
    var b = document.querySelector && document.querySelector("base[href]");
    if (b && b.href) {
      baseCache = decodeUrl(String(b.href)) || b.href;
      return baseCache;
    }
    baseCache = dataBase;
    return baseCache;
  }
  // A <base> may be inserted/pointed at any time; drop the cache when the
  // document is ready so later lookups see the final base.
  if (document.addEventListener) {
    document.addEventListener("DOMContentLoaded", function () { baseCache = null; }, false);
  }

  // ---- encoding helpers ---------------------------------------------------
  // base64url (UTF-8) — matches the server's scheme.ts encoding.
  function encodeUrl(s) {
    var b64 = btoa(unescape(encodeURIComponent(s)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // Reverse of encodeUrl for a proxy-token URL: returns the real upstream URL,
  // or the input unchanged if it is not one of our tokens.
  function decodeUrl(href) {
    var prefix = origin + "/";
    if (href.indexOf(prefix) === 0) {
      var tok = href.slice(prefix.length).split("?")[0].split("#")[0];
      if (!tok) return href;
      var b64 = tok.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      try {
        var bin = atob(b64);
        var out = "";
        for (var i = 0; i < bin.length; i++) out += String.fromCharCode(bin.charCodeAt(i) & 0xff);
        return decodeURIComponent(escape(out));
      } catch (e) { /* not a valid token */ }
    }
    return href;
  }

  // ---- URL rewriting ------------------------------------------------------
  // Rewrite an http(s) URL (absolute or resolved against the upstream base) to
  // its proxy form. Non-http schemes, pure fragments, and already-proxied
  // URLs are returned unchanged (idempotent — never double-encode).
  function proxied(u) {
    var t;
    try { t = String(u); } catch (e) { return u; }
    var s = t.trim();
    if (!s) return t;
    if (s.charAt(0) === "#") return t;
    if (/^(data|javascript|mailto|tel|about|blob|vbscript|file):/i.test(s)) return t;
    var url;
    try { url = new URL(s, effectiveBase()); } catch (e) { return t; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return t;
    if (url.origin === origin) return t; // already routed through the proxy
    return origin + "/" + encodeUrl(url.href);
  }

  // Rewrite each candidate of an srcset, preserving descriptors.
  function rewriteSrcsetClient(srcset) {
    return String(srcset).split(",").map(function (entry) {
      var parts = entry.trim().split(/\s+/);
      if (!parts[0]) return entry;
      parts[0] = proxied(parts[0]);
      return parts.join(" ");
    }).join(", ");
  }

  // Rewrite url(...) tokens in an inline CSS value.
  function rewriteStyle(css) {
    return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) {
      return "url(" + q + proxied(u) + q + ")";
    });
  }

  // ---- synchronous element-attribute rewriting ----------------------------
  var ATTR_MAP = { src: 1, srcset: 1, href: 1, action: 1, data: 1, poster: 1, background: 1, cite: 1 };

  function applyUrlAttrs(el) {
    var name;
    for (name in ATTR_MAP) {
      if (el.getAttribute && el.hasAttribute && el.hasAttribute(name)) {
        var cur = el.getAttribute(name);
        if (cur == null) continue;
        var next = name === "srcset" ? rewriteSrcsetClient(cur) : proxied(cur);
        if (next !== cur) el.setAttribute(name, next);
      }
    }
    if (el.getAttribute) {
      var styleVal = el.getAttribute("style");
      if (styleVal) {
        var styleNext = rewriteStyle(styleVal);
        if (styleNext !== styleVal) el.setAttribute("style", styleNext);
      }
    }
  }

  // Catch JS-inserted nodes and attribute changes (e.g. el.src = ... on
  // detached elements). Idempotent because proxied() passes proxied URLs
  // through, so re-applying is a no-op and the observer never loops.
  if (typeof MutationObserver === "function" && document.documentElement) {
    new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === "attributes") {
          if (m.target && m.target.tagName === "BASE") baseCache = null;
          applyUrlAttrs(m.target);
        } else if (m.type === "childList") {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var n = m.addedNodes[j];
            if (!n || n.nodeType !== 1) continue;
            applyUrlAttrs(n);
            var subs = n.querySelectorAll && n.querySelectorAll("[src],[srcset],[href],[action],[data],[poster],[background],[cite],[style]");
            if (subs) for (var k = 0; k < subs.length; k++) applyUrlAttrs(subs[k]);
          }
        }
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "href", "action", "data", "poster", "background", "cite", "style"],
    });
  }

  // Wrap the IDL setters so property assignment is rewritten with no race:
  //   img.src = "https://upstream/x.png"   ->   img.src = "<origin>/<token>"
  // Covers detached elements (new Image(); img.src = ...) that a MutationObserver
  // can never see, and fires synchronously before the fetch starts.
  var SETTERS = [
    [HTMLImageElement, "src"], [HTMLImageElement, "srcset"],
    [HTMLSourceElement, "src"], [HTMLSourceElement, "srcset"],
    [HTMLMediaElement, "src"],
    [HTMLVideoElement, "poster"],
    [HTMLScriptElement, "src"],
    [HTMLIFrameElement, "src"],
    [HTMLFrameElement, "src"],
    [HTMLEmbedElement, "src"],
    [HTMLInputElement, "src"],
    [HTMLTrackElement, "src"],
    [HTMLAnchorElement, "href"],
    [HTMLAreaElement, "href"],
    [HTMLLinkElement, "href"],
    [HTMLBaseElement, "href"],
    [HTMLFormElement, "action"],
    [HTMLObjectElement, "data"],
    [HTMLBodyElement, "background"],
    [HTMLQuoteElement, "cite"],
    [HTMLModElement, "cite"],
  ];

  function patchSetter(Proto, attr) {
    if (typeof Proto === "undefined" || !Proto.prototype) return;
    try {
      var desc = Object.getOwnPropertyDescriptor(Proto.prototype, attr);
      if (!desc || !desc.set) return;
      var origSet = desc.set;
      Object.defineProperty(Proto.prototype, attr, {
        get: desc.get,
        set: function (v) {
          // Media src may be a Blob/MediaStream — only rewrite string/URL.
          if (attr === "srcset") return origSet.call(this, rewriteSrcsetClient(v));
          if (typeof v === "string" || v instanceof URL) return origSet.call(this, proxied(v));
          return origSet.call(this, v);
        },
        enumerable: desc.enumerable,
        configurable: desc.configurable,
      });
    } catch (e) { /* prototype may be immutable in exotic hosts */ }
  }
  for (var si = 0; si < SETTERS.length; si++) patchSetter(SETTERS[si][0], SETTERS[si][1]);

  // setAttribute for URL attributes + style (dynamic HTML built via strings).
  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    name = String(name);
    if (ATTR_MAP[name]) {
      if (name === "srcset") value = rewriteSrcsetClient(value);
      else if (typeof value === "string" || value instanceof URL) value = proxied(value);
    } else if (name === "style") {
      value = rewriteStyle(value);
    }
    return origSetAttr.call(this, name, value);
  };

  // ---- fetch / Request ----------------------------------------------------
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var opts = init || {};
    // Streaming request bodies require duplex:"half" in the fetch spec.
    if (opts.body && typeof opts.body.getReader === "function") {
      opts = extend({}, opts, { duplex: "half" });
    }
    if (typeof input === "string") return origFetch(proxied(input), opts);
    if (input instanceof URL) return origFetch(proxied(input.href), opts);
    return origFetch(input, opts); // Request object (already proxied by our ctor)
  };
  function extend(out, a, b) {
    var k;
    for (k in a) out[k] = a[k];
    for (k in b) out[k] = b[k];
    return out;
  }

  var OrigRequest = window.Request;
  if (OrigRequest) {
    window.Request = function (input, init) {
      if (typeof input === "string") {
        var r = new OrigRequest(proxied(input), init);
        r.__proxyOriginalUrl = input;
        return r;
      }
      if (input instanceof URL) {
        var r2 = new OrigRequest(proxied(input.href), init);
        r2.__proxyOriginalUrl = input.href;
        return r2;
      }
      return new OrigRequest(input, init);
    };
    window.Request.prototype = OrigRequest.prototype;
  }

  // ---- XMLHttpRequest -----------------------------------------------------
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof args[1] === "string" || args[1] instanceof URL) args[1] = proxied(String(args[1]));
    return origOpen.apply(this, args);
  };

  // ---- WebSocket ----------------------------------------------------------
  var OrigWebSocket = window.WebSocket;
  function buildWs(url, protocols) {
    var v;
    try { v = new URL(String(url), effectiveBase()); } catch (e) {
      return protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
    }
    if (v.origin === origin) {
      return protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
    }
    // The proxy bridges ws: from an http: URL token, so map the socket target
    // to its http(s) form and let the server relay it (see transports/ws.ts).
    var httpUrl = (v.protocol === "wss:" ? "https://" : "http://") + v.host + v.pathname + v.search;
    var wsScheme = origin.indexOf("https:") === 0 ? "wss://" : "ws://";
    var wsUrl = wsScheme + origin.replace(/^[a-z]+:\/\//, "") + "/" + encodeUrl(httpUrl);
    return protocols !== undefined ? new OrigWebSocket(wsUrl, protocols) : new OrigWebSocket(wsUrl);
  }
  window.WebSocket = function (url, protocols) { return buildWs(url, protocols); };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;

  // ---- EventSource (SSE) --------------------------------------------------
  var OrigEventSource = window.EventSource;
  window.EventSource = function (url, options) {
    if (options !== undefined) return new OrigEventSource(proxied(String(url)), options);
    return new OrigEventSource(proxied(String(url)));
  };
  window.EventSource.prototype = OrigEventSource.prototype;
  window.EventSource.CONNECTING = OrigEventSource.CONNECTING;
  window.EventSource.OPEN = OrigEventSource.OPEN;
  window.EventSource.CLOSED = OrigEventSource.CLOSED;

  // ---- window.open --------------------------------------------------------
  var origWinOpen = window.open;
  window.open = function () {
    var args = Array.prototype.slice.call(arguments);
    if (typeof args[0] === "string" || args[0] instanceof URL) args[0] = proxied(String(args[0]));
    return origWinOpen.apply(this, args);
  };

  // ---- location.href / assign / replace -----------------------------------
  try {
    var locProto = Object.getPrototypeOf(window.location);
    var hrefDesc = Object.getOwnPropertyDescriptor(locProto, "href");
    if (hrefDesc && hrefDesc.set) {
      Object.defineProperty(locProto, "href", {
        get: hrefDesc.get,
        set: function (v) { return hrefDesc.set.call(this, proxied(String(v))); },
        enumerable: hrefDesc.enumerable,
        configurable: hrefDesc.configurable,
      });
    }
    var assignDesc = Object.getOwnPropertyDescriptor(locProto, "assign");
    if (assignDesc && assignDesc.value) {
      var origAssign = assignDesc.value;
      Object.defineProperty(locProto, "assign", {
        value: function (url) { return origAssign.call(this, proxied(String(url))); },
        writable: true, configurable: true, enumerable: false,
      });
    }
    var replaceDesc = Object.getOwnPropertyDescriptor(locProto, "replace");
    if (replaceDesc && replaceDesc.value) {
      var origLocReplace = replaceDesc.value;
      Object.defineProperty(locProto, "replace", {
        value: function (url) { return origLocReplace.call(this, proxied(String(url))); },
        writable: true, configurable: true, enumerable: false,
      });
    }
  } catch (e) { /* best-effort */ }

  // ---- history.pushState / replaceState -----------------------------------
  // SPA routers navigate with relative URLs — leave those alone so the proxy
  // path stays put. Only absolute http(s) URLs (which would escape the proxy)
  // are rewritten.
  function patchHistory(method) {
    var proto = window.history && Object.getPrototypeOf(window.history);
    if (!proto) return;
    var orig = proto[method];
    if (!orig) return;
    Object.defineProperty(proto, method, {
      value: function () {
        var args = Array.prototype.slice.call(arguments);
        if (args.length >= 3 && args[2] !== undefined && args[2] !== null) {
          var s = String(args[2]);
          if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s)) return orig.apply(this, args);
          args[2] = proxied(s);
        }
        return orig.apply(this, args);
      },
      writable: true, configurable: true, enumerable: false,
    });
  }
  patchHistory("pushState");
  patchHistory("replaceState");

  // ---- navigator.sendBeacon ----------------------------------------------
  try {
    if (navigator.sendBeacon) {
      var origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        return origBeacon(proxied(String(url)), data);
      };
    }
  } catch (e) { /* best-effort */ }

  // ---- Worker / SharedWorker (blob loader) --------------------------------
  // A worker's internal imports (importScripts, ES module graph) run outside
  // this page's reach, so instead of passing the proxied URL straight to the
  // Worker constructor we load a tiny wrapper from a blob that (a) patches the
  // worker scope (fetch/XHR/importScripts/EventSource/WebSocket) and (b) then
  // pulls the real (already proxied) worker script. The worker's own base is
  // set to the decoded upstream URL so its relative URLs resolve correctly.
  var workerBootstrap = [
    "try{(function(){",
    "var __base=self.__proxyWorkerBase||self.location.href;",
    "function __enc(s){return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}",
    "function __prox(u){var t=String(u).trim();if(!t||t.charAt(0)==='#')return u;if(/^(data|javascript|mailto|tel|about|blob|vbscript|file):/i.test(t))return u;var url;try{url=new URL(t,__base);}catch(e){return u;}if(url.protocol!=='http:'&&url.protocol!=='https:')return u;if(url.origin===self.origin)return u;return self.origin+'/'+__enc(url.href);}",
    "var __origFetch=self.fetch;",
    "self.fetch=function(u,o){if(typeof u==='string'||(u instanceof URL)){return __origFetch(__prox(u),o);}return __origFetch(u,o);};",
    "var __open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);if(a.length>=2)a[1]=__prox(String(u));return __open.apply(this,a);};",
    "var __is=importScripts;self.importScripts=function(){var a=[].slice.call(arguments).map(function(x){return __prox(x);});return __is.apply(null,a);};",
    "var __ES=EventSource;self.EventSource=function(u,o){if(o!==undefined){return new __ES(__prox(String(u)),o);}return new __ES(__prox(String(u)));};self.EventSource.prototype=__ES.prototype;",
    "var __WS=WebSocket;self.WebSocket=function(u,p){var v;try{v=new URL(String(u),__base);}catch(e){return p!==undefined?new __WS(u,p):new __WS(u);}if(v.origin===self.origin){return p!==undefined?new __WS(u,p):new __WS(u);}var hu=(v.protocol==='wss:'?'https://':'http://')+v.host+v.pathname+v.search;var w=(self.origin.indexOf('https:')===0?'wss://':'ws://')+self.origin.replace(/^[a-z]+:\\/\\//,'')+'/'+__enc(hu);return p!==undefined?new __WS(w,p):new __WS(w);};self.WebSocket.prototype=__WS.prototype;",
    "})();}catch(e){}"
  ].join("");

  function workerBlob(target, upstreamBase, isModule) {
    // The base must be assigned BEFORE workerBootstrap runs — the bootstrap
    // captures __proxyWorkerBase synchronously at startup (a blob URL base
    // would make relative worker URLs resolve to the proxy origin and stay
    // unproxied).
    var body =
      "self.__proxyWorkerBase=" + JSON.stringify(upstreamBase) + ";" +
      workerBootstrap +
      (isModule
        ? "\nimport " + JSON.stringify(target) + ";"
        : "\nimportScripts(" + JSON.stringify(target) + ");");
    return new Blob([body], { type: "text/javascript" });
  }

  var OrigWorker = window.Worker;
  window.Worker = function (url, options) {
    var src = typeof url === "string" ? url : (url && url.url) ? url.url : null;
    if (src === null || /^(data|blob):/i.test(src)) return new OrigWorker(url, options);
    var target = proxied(src);
    var upstreamBase = decodeUrl(target) || src;
    var isModule = !!(options && options.type === "module");
    return new OrigWorker(URL.createObjectURL(workerBlob(target, upstreamBase, isModule)), options);
  };
  window.Worker.prototype = OrigWorker.prototype;
  window.Worker.__orig = OrigWorker;

  if (typeof SharedWorker !== "undefined") {
    var OrigSharedWorker = window.SharedWorker;
    window.SharedWorker = function (url, options) {
      var src = typeof url === "string" ? url : (url && url.url) ? url.url : null;
      if (src === null || /^(data|blob):/i.test(src)) return new OrigSharedWorker(url, options);
      var target = proxied(src);
      var upstreamBase = decodeUrl(target) || src;
      return new OrigSharedWorker(URL.createObjectURL(workerBlob(target, upstreamBase, false)), options);
    };
    window.SharedWorker.prototype = OrigSharedWorker.prototype;
    window.SharedWorker.__orig = OrigSharedWorker;
  }

  // ---- navigator.serviceWorker neutralization -----------------------------
  // A real service worker would intercept our proxied requests and break the
  // proxy mapping. Shut the surface down with no-ops so feature detection
  // still works (sites check navigator.serviceWorker.register exists).
  try {
    if ("serviceWorker" in navigator) {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        get: function () {
          return {
            controller: null,
            ready: Promise.resolve(),
            register: function () { return Promise.resolve(); },
            getRegistration: function () { return Promise.resolve(undefined); },
            getRegistrations: function () { return Promise.resolve([]); },
          };
        },
      });
    }
  } catch (e) { /* best-effort */ }
})();
