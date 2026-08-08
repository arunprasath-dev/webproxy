/**
 * Proxy client bootstrap.
 * Injected into every proxied page. Overrides browser APIs that build URLs at
 * runtime (fetch, XMLHttpRequest, WebSocket, EventSource, window.open, and the
 * location.href setter) so dynamic requests route through the proxy.
 *
 * The proxy origin is window.location.origin, since this script is served from
 * the proxy itself.
 */
(function () {
  "use strict";
  if (window.__proxyBootstrap) return;
  window.__proxyBootstrap = true;

  var origin = window.location.origin;

  // base64url (UTF-8) — matches the server's scheme.ts encoding.
  function encodeUrl(s) {
    var b64 = btoa(unescape(encodeURIComponent(s)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function shouldProxy(protocol) {
    return protocol === "http:" || protocol === "https:";
  }

  // Rewrite an http(s) URL to its proxy form; leave everything else untouched.
  function proxied(u) {
    try {
      var url = new URL(u, window.location.href);
      if (shouldProxy(url.protocol)) {
        return origin + "/" + encodeUrl(url.href);
      }
      return u;
    } catch (e) {
      return u;
    }
  }

  // ---- fetch -------------------------------------------------------------
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === "string") {
      return origFetch(proxied(input), init);
    }
    if (input && input.url) {
      // Request object — pass a rewritten copy.
      var newReq = new Request(proxied(input.url), {
        method: input.method,
        headers: input.headers,
        body: typeof input.body === "string" || input.body instanceof Blob || input.body == null ? input.body : undefined,
        mode: input.mode,
        credentials: input.credentials,
        signal: input.signal,
      });
      return origFetch(newReq, init);
    }
    return origFetch(input, init);
  };

  // ---- XMLHttpRequest ----------------------------------------------------
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, async, user, pass) {
    return origOpen.call(this, method, proxied(String(url)), async, user, pass);
  };

  // ---- WebSocket ---------------------------------------------------------
  var OrigWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    var parsed = new URL(String(url), window.location.href);
    var httpUrl =
      (parsed.protocol === "wss:" ? "https://" : "http://") + parsed.host + parsed.pathname + parsed.search;
    var wsUrl = (origin.indexOf("https:") === 0 ? "wss://" : "ws://") + origin.replace(/^[a-z]+:\/\//, "") + "/" + encodeUrl(httpUrl);
    if (protocols !== undefined) return new OrigWebSocket(wsUrl, protocols);
    return new OrigWebSocket(wsUrl);
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;

  // ---- EventSource (SSE) -------------------------------------------------
  var OrigEventSource = window.EventSource;
  window.EventSource = function (url, options) {
    return new OrigEventSource(proxied(String(url)), options);
  };
  window.EventSource.prototype = OrigEventSource.prototype;
  window.EventSource.CONNECTING = OrigEventSource.CONNECTING;
  window.EventSource.OPEN = OrigEventSource.OPEN;
  window.EventSource.CLOSED = OrigEventSource.CLOSED;

  // ---- window.open -------------------------------------------------------
  var origOpenWin = window.open;
  window.open = function (url, target, features) {
    if (typeof url === "string") return origOpenWin(proxied(url), target, features);
    return origOpenWin(url, target, features);
  };

  // ---- location.href setter ---------------------------------------------
  try {
    var locProto = Object.getPrototypeOf(window.location);
    var hrefDesc = Object.getOwnPropertyDescriptor(locProto, "href");
    if (hrefDesc && hrefDesc.set) {
      Object.defineProperty(locProto, "href", {
        get: hrefDesc.get,
        set: function (v) {
          return hrefDesc.set.call(this, proxied(String(v)));
        },
        enumerable: hrefDesc.enumerable,
        configurable: hrefDesc.configurable,
      });
    }
  } catch (e) {
    /* best-effort */
  }
})();
