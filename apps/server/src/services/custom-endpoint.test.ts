import { describe, expect, test } from "bun:test";
import { isPublicAddress } from "./custom-endpoint";

describe("custom provider endpoint policy", () => {
  test("rejects loopback, link-local, private, carrier NAT, and metadata ranges", () => {
    for (const address of [
      "127.0.0.1", "10.0.0.4", "172.16.0.1", "172.31.255.1",
      "192.168.1.2", "169.254.169.254", "100.64.0.1", "192.0.2.1",
      "198.18.0.1", "198.51.100.2", "203.0.113.2", "::1", "::ffff:127.0.0.1",
      "fd00::1", "fe80::1", "2001:db8::1", "64:ff9b::7f00:1",
      "2001::1", "2001:20::1", "3fff::1",
    ]) expect(isPublicAddress(address)).toBe(false);
  });

  test("accepts public IPv4 and IPv6 addresses", () => {
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
});
