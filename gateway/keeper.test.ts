import { expect, test } from "bun:test";
import { vtxosNeedingRefresh, type Vtxo } from "./keeper";

const v = (id: string, expiry: number, state = "spendable"): Vtxo =>
  ({ id, amount_sat: 500, expiry_height: expiry, state: { type: state } });

test("picks only VTXOs inside the threshold", () => {
  const tip = 1000;
  const due = vtxosNeedingRefresh([v("near", 1100), v("far", 1500)], tip, 144);
  expect(due.map((x) => x.id)).toEqual(["near"]);
});

test("boundary is inclusive", () => {
  expect(vtxosNeedingRefresh([v("edge", 1144)], 1000, 144)).toHaveLength(1);
  expect(vtxosNeedingRefresh([v("edge", 1145)], 1000, 144)).toHaveLength(0);
});

test("already expired VTXOs are still selected", () => {
  // Negative blocks left: refreshing may fail, but not trying guarantees loss.
  expect(vtxosNeedingRefresh([v("late", 900)], 1000, 144)).toHaveLength(1);
});

test("ignores VTXOs that are not spendable", () => {
  expect(vtxosNeedingRefresh([v("locked", 1100, "locked")], 1000, 144)).toHaveLength(0);
});
