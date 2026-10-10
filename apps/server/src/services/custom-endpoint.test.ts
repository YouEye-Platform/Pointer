import { describe, expect, test } from "bun:test";
import { isPublicAddress, isAllowedEndpointAddress, validateProviderEndpoint } from "./custom-endpoint";

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


test("local policy permits LAN/loopback while keeping metadata and special destinations blocked", () => {
  for (const address of ["10.0.0.4","192.168.31.211","127.0.0.1","::1","fd00::1","100.64.1.1"]) {
    expect(isAllowedEndpointAddress(address,true)).toBe(true);
    expect(isAllowedEndpointAddress(address,false)).toBe(false);
  }
  for (const address of ["168.63.129.16","fd00:ec2::254","fd20:ce::254","169.254.169.254","100.100.100.200","0.0.0.0","224.0.0.1","fe80::1","::ffff:127.0.0.1","::","2001:db8::1"]) expect(isAllowedEndpointAddress(address,true)).toBe(false);
});
test("schemes, credentials, queries and metadata cannot bypass endpoint policy", async () => {
  for (const url of ["file:///models", "ftp://127.0.0.1", "https://user:password@127.0.0.1", "http://169.254.169.254", "http://100.100.100.200", "http://127.0.0.1?token=fixture", "http://127.0.0.1#fragment"]) await expect(validateProviderEndpoint(url,true)).rejects.toThrow();
  await expect(validateProviderEndpoint("http://127.0.0.1",false)).rejects.toThrow();
  expect(await validateProviderEndpoint("http://127.0.0.1:8080/v1",true)).toBe("http://127.0.0.1:8080/v1");
});
