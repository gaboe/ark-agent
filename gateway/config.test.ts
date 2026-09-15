import { expect, test, afterEach } from "bun:test";
import { intFromEnv, keysFromEnv } from "./config";

const clean = (...names: string[]) => names.forEach((n) => delete process.env[n]);
afterEach(() => clean("T_NUM", "K_READ", "K_SPEND"));

test("falls back only when unset or empty", () => {
  expect(intFromEnv("T_NUM", 7)).toBe(7);
  process.env.T_NUM = "";
  expect(intFromEnv("T_NUM", 7)).toBe(7);
  process.env.T_NUM = "42";
  expect(intFromEnv("T_NUM", 7)).toBe(42);
});

test("malformed values throw instead of becoming NaN", () => {
  process.env.T_NUM = "abc";
  expect(() => intFromEnv("T_NUM", 7)).toThrow(/whole number/);
  // The old shell entrypoint accepted durations like "6h"; Number("6h") is NaN,
  // and setInterval(NaN) clamps to 1ms, so this must not pass silently.
  process.env.T_NUM = "6h";
  expect(() => intFromEnv("T_NUM", 7)).toThrow(/whole number/);
  process.env.T_NUM = "1.5";
  expect(() => intFromEnv("T_NUM", 7)).toThrow(/whole number/);
});

test("range is enforced", () => {
  process.env.T_NUM = "0";
  expect(() => intFromEnv("T_NUM", 7, { min: 1 })).toThrow(/between/);
});

test("keys shorter than the minimum are rejected", () => {
  process.env.K_READ = "x";
  expect(() => keysFromEnv({ read: "K_READ" })).toThrow(/at least/);
});

test("duplicate keys across scopes are rejected", () => {
  process.env.K_READ = "a".repeat(24);
  process.env.K_SPEND = "a".repeat(24);
  expect(() => keysFromEnv({ read: "K_READ", spend: "K_SPEND" })).toThrow(/scopes would collapse/);
});

test("unset keys are null, not errors", () => {
  process.env.K_READ = "b".repeat(24);
  const keys = keysFromEnv({ read: "K_READ", spend: "K_SPEND" });
  expect(keys.read).toHaveLength(24);
  expect(keys.spend).toBeNull();
});
