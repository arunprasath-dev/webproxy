import { describe, expect, it } from "vitest";
import { isBlockedIp } from "../src/security/ip.js";
import { validateTarget, SsrfError } from "../src/security/ssrf.js";

describe("isBlockedIp", () => {
  it("blocks loopback, private, link-local, and metadata", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.0.0.5")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("0.0.0.0")).toBe(true);
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("fc00::1")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("1.1.1.1")).toBe(false);
  });
});

describe("validateTarget", () => {
  const opts = { allowedProtocols: ["http", "https"], allowedHosts: [] };

  it("rejects non-http protocols", async () => {
    await expect(validateTarget("ftp://example.com", opts)).rejects.toThrow(SsrfError);
  });

  it("rejects literal private IPs", async () => {
    await expect(validateTarget("http://127.0.0.1/", opts)).rejects.toThrow(SsrfError);
  });

  it("rejects hostnames resolving to private IPs", async () => {
    const resolve = async () => ["10.0.0.1"];
    await expect(
      validateTarget("https://example.com/", { ...opts, resolve }),
    ).rejects.toThrow(SsrfError);
  });

  it("allows hostnames resolving only to public IPs", async () => {
    const resolve = async () => ["8.8.8.8"];
    await expect(
      validateTarget("https://example.com/", { ...opts, resolve }),
    ).resolves.toBeUndefined();
  });

  it("rejects hostnames that fail to resolve", async () => {
    const resolve = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(
      validateTarget("https://no-such-host.invalid/", { ...opts, resolve }),
    ).rejects.toThrow(SsrfError);
  });

  it("rejects hosts not in an allowlist when configured", async () => {
    await expect(
      validateTarget("https://example.com/", { allowedProtocols: ["https"], allowedHosts: ["allowed.example"] }),
    ).rejects.toThrow(SsrfError);
  });
});
