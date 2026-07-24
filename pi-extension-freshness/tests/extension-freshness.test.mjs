import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { renderRows } from "../extensions/extension-freshness.ts";

const theme = {
  fg: (_color, text) => `\x1b[31m${text}\x1b[0m`,
};

function report(rows) {
  return {
    generatedAt: "2026-07-24T00:00:00.000Z",
    rows,
    counts: {
      fresh: rows.filter((row) => row.status === "fresh").length,
      aging: rows.filter((row) => row.status === "aging").length,
      stale: rows.filter((row) => row.status === "stale").length,
      unknown: rows.filter((row) => row.status === "unknown").length,
    },
  };
}

test("freshness rendering never exceeds narrow terminal widths", () => {
  const rows = [
    {
      path: "/tmp/pi-extension-freshness/extensions/extension-freshness.ts",
      source: "local",
      scope: "user",
      origin: "test",
      label: "pi-extension-freshness/extensions/extension-freshness.ts",
      sourceLabel: "local:user",
      updatedDate: "2026-07-24",
      ageDays: 0,
      age: "today",
      status: "fresh",
      freshnessSource: "git",
    },
  ];

  for (const width of [12, 36, 56]) {
    const lines = renderRows(report(rows), theme, width, false);
    assert.ok(lines.length > 0);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `rendered line exceeded width ${width}: ${lines.map(visibleWidth).join(", ")}`,
    );
  }
});

test("empty freshness reports also obey narrow terminal widths", () => {
  const width = 12;
  const lines = renderRows(report([]), theme, width, false);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
});
