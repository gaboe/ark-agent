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

import { parseVtxos } from "./keeper";

test("parseVtxos rejects shapes that would throw later", () => {
  expect(() => parseVtxos({ message: "unauthorized" })).toThrow(/not an array/);
  expect(() => parseVtxos([{ id: "a", amount_sat: 1, expiry_height: 2 }])).toThrow(/missing expected fields/);
  expect(() => parseVtxos([{ id: 1, amount_sat: 1, expiry_height: 2, state: { type: "x" } }])).toThrow(/missing/);
});

test("parseVtxos accepts a well-formed list", () => {
  const ok = parseVtxos([{ id: "a", amount_sat: 500, expiry_height: 100, state: { type: "spendable" } }]);
  expect(ok).toHaveLength(1);
});
