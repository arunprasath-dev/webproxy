import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { decodeTarget } from "../proxy/scheme.js";
import { validateTarget } from "../security/ssrf.js";
import { loadConfig } from "../config/config.js";

/**
 * WebSocket proxy. Handles `upgrade` requests on the proxy origin, decodes the
 * target, and bridges frames between the browser WebSocket and an upstream
 * WebSocket (scheme swapped https->wss / http->ws).
 */
export class WebSocketProxy {
  private readonly wss = new WebSocketServer({ noServer: true });
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
    const upstream = new WebSocket(upstreamUrl);

    const toBuffer = (data: unknown): Buffer =>
      Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

    const relay = (from: WebSocket, to: WebSocket) => {
      from.on("message", (data) => {
        if (to.readyState === to.OPEN) to.send(toBuffer(data));
      });
      from.on("close", () => to.close());
      from.on("error", () => to.close());
    };

    // Buffer browser messages until upstream is open.
    let upstreamOpen = false;
    const queue: Buffer[] = [];
    browser.on("message", (data) => {
      const buf = toBuffer(data);
      if (upstreamOpen) upstream.send(buf);
      else queue.push(buf);
    });
    upstream.on("open", () => {
      upstreamOpen = true;
      for (const m of queue) upstream.send(m);
      queue.length = 0;
      relay(upstream, browser);
    });
    browser.on("close", () => upstream.close());
    browser.on("error", () => upstream.close());
  }
}
