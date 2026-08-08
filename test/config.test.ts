import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";

describe("loadConfig", () => {
  it("defaults UPSTREAM_IP_FAMILY to auto", () => {
    expect(loadConfig({}).UPSTREAM_IP_FAMILY).toBe("auto");
  });

  it("parses ipv4 / ipv6", () => {
    expect(loadConfig({ UPSTREAM_IP_FAMILY: "ipv4" }).UPSTREAM_IP_FAMILY).toBe("ipv4");
    expect(loadConfig({ UPSTREAM_IP_FAMILY: "ipv6" }).UPSTREAM_IP_FAMILY).toBe("ipv6");
  });

  it("rejects an unknown family", () => {
    expect(() => loadConfig({ UPSTREAM_IP_FAMILY: "bogus" })).toThrow(/Invalid configuration/);
  });
});
