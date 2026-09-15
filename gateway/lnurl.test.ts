import { expect, test } from "bun:test";
import { metadataString, parseAmountMsat, payRequestParams, lightningAddress } from "./lnurl";

const cfg = {
  name: "agent",
  domain: "pay.gaboe.xyz",
  minSendableMsat: 1000,
  maxSendableMsat: 10_000_000,
};

test("address and callback are built from the same parts", () => {
  expect(lightningAddress(cfg)).toBe("agent@pay.gaboe.xyz");
  expect(payRequestParams(cfg).callback)
    .toBe("https://pay.gaboe.xyz/.well-known/lnurlp/agent");
});

test("metadata is valid JSON containing the identifier", () => {
  const parsed = JSON.parse(metadataString(cfg));
  expect(parsed[0]).toEqual(["text/identifier", "agent@pay.gaboe.xyz"]);
  expect(parsed[1][0]).toBe("text/plain");
});

test("amount must be present and positive", () => {
  expect(parseAmountMsat(undefined, cfg)).toMatchObject({ ok: false });
  expect(parseAmountMsat("", cfg)).toMatchObject({ ok: false });
  expect(parseAmountMsat("0", cfg)).toMatchObject({ ok: false });
  expect(parseAmountMsat("-1000", cfg)).toMatchObject({ ok: false });
  expect(parseAmountMsat("abc", cfg)).toMatchObject({ ok: false });
});

test("amount is converted from msat to sat", () => {
  expect(parseAmountMsat("1000", cfg)).toEqual({ ok: true, sats: 1 });
  expect(parseAmountMsat("5000000", cfg)).toEqual({ ok: true, sats: 5000 });
});

test("sub-satoshi amounts are refused, not rounded", () => {
  const r = parseAmountMsat("1500", cfg);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("whole number of satoshis");
});

test("bounds are enforced", () => {
  expect(parseAmountMsat("999", cfg)).toMatchObject({ ok: false });
  expect(parseAmountMsat("10000001000", cfg)).toMatchObject({ ok: false });
});
