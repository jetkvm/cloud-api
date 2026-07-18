import { describe, expect, it } from "vitest";
import { normalizeReturnTo } from "../src/oidc";

describe("normalizeReturnTo", () => {
  const appHostname = "https://jetkvm.example.com";

  it("removes control characters from return URLs", () => {
    expect(
      normalizeReturnTo("https://jetkvm.example.com/\r\n\tdevices", appHostname),
    ).toBe("https://jetkvm.example.com/devices");
  });

  it("falls back when return URLs point off-origin", () => {
    expect(normalizeReturnTo("https://example.net/devices", appHostname)).toBe(
      "https://jetkvm.example.com/devices",
    );
  });

  it("allows relative return URLs on the app origin", () => {
    expect(normalizeReturnTo("/devices", appHostname)).toBe(
      "https://jetkvm.example.com/devices",
    );
  });
});
