import { expect, test } from "bun:test";
import { SpendTracker, scopeAllows } from "./policy";

const limits = { perTxSat: 1000, perDaySat: 2500, allowedDestinations: [] as string[] };

test("scopes are hierarchical", () => {
  expect(scopeAllows("spend", "read")).toBe(true);
  expect(scopeAllows("read", "spend")).toBe(false);
  expect(scopeAllows("invoice", "invoice")).toBe(true);
});

test("per-transaction cap", () => {
  const t = new SpendTracker(limits);
  expect(t.reserve(1000, "x")).toBeNull();
  t.release(1000);
  expect(t.reserve(1001, "x")).toContain("per-transaction limit");
});

test("reserving charges immediately, so concurrent sends cannot both pass", () => {
  const t = new SpendTracker(limits);
  // Two in-flight payments that would together exceed the cap: the second must
  // be refused even though the first has not settled yet.
  expect(t.reserve(1000, "x")).toBeNull();
  expect(t.reserve(1000, "x")).toBeNull();
  expect(t.reserve(1000, "x")).toContain("daily limit");
  expect(t.status().spent_today_sat).toBe(2000);
});

test("release gives quota back when a payment fails", () => {
  const t = new SpendTracker(limits);
  t.reserve(1000, "x");
  expect(t.status().spent_today_sat).toBe(1000);
  t.release(1000);
  expect(t.status().spent_today_sat).toBe(0);
  expect(t.reserve(1000, "x")).toBeNull();
});

test("commit keeps the reservation", () => {
  const t = new SpendTracker(limits);
  t.reserve(1000, "x");
  t.commit(1000);
  expect(t.status().spent_today_sat).toBe(1000);
});

test("release never drives the tally negative", () => {
  const t = new SpendTracker(limits);
  t.release(500);
  expect(t.status().spent_today_sat).toBe(0);
});

test("rejects nonsense amounts without charging", () => {
  const t = new SpendTracker(limits);
  expect(t.reserve(0, "x")).toContain("positive");
  expect(t.reserve(-5, "x")).toContain("positive");
  expect(t.reserve(1.5, "x")).toContain("positive");
  expect(t.status().spent_today_sat).toBe(0);
});

test("a refused reservation does not consume quota", () => {
  const t = new SpendTracker(limits);
  expect(t.reserve(5000, "x")).toContain("per-transaction limit");
  expect(t.status().spent_today_sat).toBe(0);
});

test("destination allowlist applies only when set", () => {
  const open = new SpendTracker(limits);
  expect(open.reserve(10, "anywhere")).toBeNull();

  const closed = new SpendTracker({ ...limits, allowedDestinations: ["ark1good"] });
  expect(closed.reserve(10, "ark1good")).toBeNull();
  expect(closed.reserve(10, "ark1bad")).toContain("allowlist");
});
