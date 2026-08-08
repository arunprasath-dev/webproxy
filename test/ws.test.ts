import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/config.js";
import { encodeTarget } from "../src/proxy/scheme.js";
import { WebSocketProxy } from "../src/transports/ws.js";

describe("websocket proxy", () => {
  let echo: WebSocketServer;
  let echoPort: number;
  let app: ReturnType<typeof buildApp>;
  let proxyPort: number;

  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_IPS = "true";
    process.env.PROXY_PUBLIC_ORIGIN = "http://127.0.0.1:0";

    echo = new WebSocketServer({ port: 0 });
    echo.on("connection", (ws) => {
      ws.on("message", (data) => ws.send(data)); // echo
    });
    await new Promise((r) => echo.on("listening", r));
    echoPort = (echo.address() as { port: number }).port;

    app = buildApp(loadConfig());
    new WebSocketProxy().attach(app.server);
    await app.listen({ port: 0, host: "127.0.0.1" });
    proxyPort = (app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await app.close();
    await new Promise((r) => echo.close(r));
  });

  it("round-trips a message through the proxy to the echo server", async () => {
    // Encode the ws echo target as its http form (the bootstrap maps ws->http).
    const target = `http://127.0.0.1:${echoPort}/`;
    const proxyWsUrl = `ws://127.0.0.1:${proxyPort}/${encodeTarget(target)}`;

    const ws = new WebSocket(proxyWsUrl);
    const reply = new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => resolve(String(data)));
      ws.on("error", reject);
    });
    await new Promise((r) => ws.on("open", r));
    ws.send("hello-proxy");
    expect(await reply).toBe("hello-proxy");
    ws.close();
  });
});
