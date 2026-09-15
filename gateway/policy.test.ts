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
  expect(t.check(1000, "x")).toBeNull();
  expect(t.check(1001, "x")).toContain("per-transaction limit");
});

test("daily cap counts only recorded spends", () => {
  const t = new SpendTracker(limits);
  // Checking alone must not consume quota, or a failed payment would.
  t.check(1000, "x");
  t.check(1000, "x");
  expect(t.status().spent_today_sat).toBe(0);

  t.record(1000); t.record(1000);
  expect(t.check(1000, "x")).toContain("daily limit");
  expect(t.check(500, "x")).toBeNull();
});

test("rejects nonsense amounts", () => {
  const t = new SpendTracker(limits);
  expect(t.check(0, "x")).toContain("positive");
  expect(t.check(-5, "x")).toContain("positive");
  expect(t.check(1.5, "x")).toContain("positive");
});

test("destination allowlist applies only when set", () => {
  const open = new SpendTracker(limits);
  expect(open.check(10, "anywhere")).toBeNull();

  const closed = new SpendTracker({ ...limits, allowedDestinations: ["ark1good"] });
  expect(closed.check(10, "ark1good")).toBeNull();
  expect(closed.check(10, "ark1bad")).toContain("allowlist");
});
