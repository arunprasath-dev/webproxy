import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { decodeTarget } from "../proxy/scheme.js";
import { validateTarget } from "../security/ssrf.js";
import { loadConfig } from "../config/config.js";

/**
 * WebSocket proxy. Handles `upgrade` requests on the proxy origin, decodes the
 * target, and bridges frames between the browser WebSocket and an upstream
 * WebSocket (scheme swapped https->wss / http->ws).
 */
export class WebSocketProxy {
  // The browser handshake needs a negotiated subprotocol when one is offered,
  // otherwise the browser errors ("Server sent no subprotocol"). Accept the
  // first requested protocol; the upstream leg re-negotiates with the upstream.
  private readonly wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  });
  private readonly cfg = loadConfig();

  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onUpgrade(req, ws);
      });
    });
  }

  private async onUpgrade(req: IncomingMessage, browser: WebSocket): Promise<void> {
    const token = (req.url ?? "").replace(/^\/+/, "");
    const target = decodeTarget(token);
    if (!target) return browser.close();

    try {
      await validateTarget(target, {
        allowedProtocols: this.cfg.ALLOWED_PROTOCOLS,
        allowedHosts: this.cfg.ALLOWED_HOSTS,
        allowPrivate: this.cfg.ALLOW_PRIVATE_IPS,
      });
    } catch {
      return browser.close();
    }

    const upstreamUrl = target.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    // Forward the client-requested subprotocols so the upstream can negotiate.
    // If the upstream accepts one, ws sets the header on its own handshake.
    const requestedProtocols = (req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const upstream = new WebSocket(upstreamUrl, requestedProtocols.length ? requestedProtocols : undefined);

    const relay = (from: WebSocket, to: WebSocket) => {
      from.on("message", (data, isBinary) => {
        if (to.readyState === to.OPEN) to.send(data, { binary: isBinary });
      });
      from.on("close", () => to.close());
      from.on("error", () => to.close());
    };

    // Buffer browser messages until upstream is open, preserving opcode.
    let upstreamOpen = false;
    const queue: { data: RawData; isBinary: boolean }[] = [];
    browser.on("message", (data, isBinary) => {
      if (upstreamOpen) upstream.send(data, { binary: isBinary });
      else queue.push({ data, isBinary });
    });
    upstream.on("open", () => {
      upstreamOpen = true;
      for (const m of queue) upstream.send(m.data, { binary: m.isBinary });
      queue.length = 0;
      relay(upstream, browser);
    });
    browser.on("close", () => upstream.close());
    browser.on("error", () => upstream.close());
  }
}
