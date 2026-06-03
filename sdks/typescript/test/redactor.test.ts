// V5.6 — PII redaction correctness
// Uses relative import from ../src/_redactor (not @scopecall/scopecall-js/internal — that subpath doesn't exist)

import { describe, it, expect } from "vitest";
import { redact, Redactor } from "../src/_redactor.js";

describe("V5.6 — PII redaction: default patterns", () => {
  it("SSN is redacted", () => {
    expect(redact("My SSN is 123-45-6789.")).toContain("[SSN]");
    expect(redact("My SSN is 123-45-6789.")).not.toContain("123-45-6789");
  });

  it("email is redacted", () => {
    expect(redact("Contact me at user@example.com")).toContain("[EMAIL]");
    expect(redact("Contact me at user@example.com")).not.toContain("user@example.com");
  });

  it("phone is redacted", () => {
    expect(redact("Call 415-555-1234 for support")).toContain("[PHONE]");
  });

  it("IP address is redacted", () => {
    expect(redact("Server at 192.168.1.100")).toContain("[IP]");
    expect(redact("Server at 192.168.1.100")).not.toContain("192.168.1.100");
  });

  it("credit card (valid Luhn) is redacted", () => {
    // 4111111111111111 is a well-known test Visa number (passes Luhn)
    expect(redact("Card: 4111-1111-1111-1111")).toContain("[CARD]");
  });

  it("credit card (invalid Luhn) is NOT redacted", () => {
    // 4111111111111112 fails Luhn check
    expect(redact("Card: 4111-1111-1111-1112")).not.toContain("[CARD]");
    expect(redact("Card: 4111-1111-1111-1112")).toContain("4111-1111-1111-1112");
  });

  it("text without PII is returned unchanged", () => {
    const clean = "The quick brown fox jumps over the lazy dog.";
    expect(redact(clean)).toBe(clean);
  });

  it("multiple PII types redacted in one pass", () => {
    const text = "Email user@test.com and SSN 987-65-4321 found.";
    const result = redact(text);
    expect(result).toContain("[EMAIL]");
    expect(result).toContain("[SSN]");
    expect(result).not.toContain("user@test.com");
    expect(result).not.toContain("987-65-4321");
  });
});

describe("Redactor — custom additional patterns", () => {
  it("custom pattern is applied after default patterns", () => {
    const r = new Redactor([{ name: "ACCT", regex: "ACCT-\\d{6}" }]);
    const result = r.redact("Account ACCT-123456 with email test@example.com");
    expect(result).toContain("[ACCT]");
    expect(result).toContain("[EMAIL]");
    expect(result).not.toContain("ACCT-123456");
  });

  it("redactor with no additional patterns behaves like default redact()", () => {
    const r = new Redactor();
    expect(r.redact("SSN 111-22-3333")).toBe(redact("SSN 111-22-3333"));
  });
});

describe("Redactor — idempotency and edge cases", () => {
  it("empty string returns empty string", () => {
    expect(redact("")).toBe("");
  });

  it("consecutive calls don't double-redact", () => {
    const once = redact("user@example.com");
    const twice = redact(once);
    expect(once).toBe(twice);
  });
});
