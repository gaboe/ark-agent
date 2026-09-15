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

test("the tracked-key map stays bounded under fabricated keys", () => {
  let now = 0;
  const rl = new RateLimiter(5, 60_000, () => now, 50);
  for (let i = 0; i < 500; i++) rl.allow(`key-${i}`);
  // @ts-expect-error reaching into private state is the point of the test
  expect(rl.hits.size).toBeLessThanOrEqual(50);
});
