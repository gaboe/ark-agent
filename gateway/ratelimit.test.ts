import { expect, test } from "bun:test";
import { RateLimiter } from "./ratelimit";

test("allows up to max then blocks", () => {
  let now = 0;
  const rl = new RateLimiter(3, 1000, () => now);
  expect(rl.allow("a")).toBe(true);
  expect(rl.allow("a")).toBe(true);
  expect(rl.allow("a")).toBe(true);
  expect(rl.allow("a")).toBe(false);
});

test("window resets", () => {
  let now = 0;
  const rl = new RateLimiter(1, 1000, () => now);
  expect(rl.allow("a")).toBe(true);
  expect(rl.allow("a")).toBe(false);
  now = 1000;
  expect(rl.allow("a")).toBe(true);
});

test("keys are independent", () => {
  let now = 0;
  const rl = new RateLimiter(1, 1000, () => now);
  expect(rl.allow("a")).toBe(true);
  expect(rl.allow("b")).toBe(true);
  expect(rl.allow("a")).toBe(false);
});
