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

    echo = new WebSocketServer({
      port: 0,
      // Accept the first requested subprotocol so the forwarding is observable.
      handleProtocols: (protocols) => protocols.values().next().value ?? false,
    });
    echo.on("connection", (ws) => {
      // Echo preserving the frame opcode (text stays text, binary stays binary).
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
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

  it("preserves text vs binary opcodes in both directions", async () => {
    const target = `http://127.0.0.1:${echoPort}/`;
    const proxyWsUrl = `ws://127.0.0.1:${proxyPort}/${encodeTarget(target)}`;

    const ws = new WebSocket(proxyWsUrl);
    const seen: { data: unknown; isBinary: boolean }[] = [];
    ws.on("message", (data, isBinary) => seen.push({ data, isBinary }));
    await new Promise((r) => ws.on("open", r));
    ws.send("text-frame");
    ws.send(Buffer.from([0x00, 0x01, 0x02]));
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (seen.length >= 2) {
          clearInterval(iv);
          resolve();
        }
      }, 10);
    });
    const textMsg = seen[0]!;
    const binMsg = seen[1]!;
    expect(textMsg.isBinary).toBe(false);
    expect(String(textMsg.data)).toBe("text-frame");
    expect(binMsg.isBinary).toBe(true);
    expect(Buffer.from(binMsg.data as Uint8Array)).toEqual(Buffer.from([0x00, 0x01, 0x02]));
    ws.close();
  });

  it("forwards the requested subprotocol to the upstream", async () => {
    const target = `http://127.0.0.1:${echoPort}/`;
    const proxyWsUrl = `ws://127.0.0.1:${proxyPort}/${encodeTarget(target)}`;

    const ws = new WebSocket(proxyWsUrl, ["chat-v1", "chat-v2"]);
    await new Promise((r) => ws.on("open", r));
    // The proxy relays the client's protocol list upstream; both legs negotiate
    // the first offered protocol, so the browser sees it negotiated too.
    expect(ws.protocol).toBe("chat-v1");
    ws.close();
  });
});
