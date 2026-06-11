import assert from "node:assert/strict";
import test from "node:test";

import { getDelayUntilNextCandleCloseGrace } from "./websocketRunner.js";

test("candle close timer fires after the next UTC 4h close plus grace", () => {
  const now = Date.parse("2026-06-08T07:59:50.000Z");
  const graceMs = 10_000;

  assert.equal(getDelayUntilNextCandleCloseGrace(now, graceMs), 19_999);
});

test("candle close timer skips to the next boundary when current close grace has passed", () => {
  const now = Date.parse("2026-06-08T08:00:10.000Z");
  const graceMs = 10_000;

  assert.equal(getDelayUntilNextCandleCloseGrace(now, graceMs), 14_399_999);
});
