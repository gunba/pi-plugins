import assert from "node:assert/strict";
import test from "node:test";
import { deskCommand, deskCommandCatalog } from "../src/client/desk-commands.ts";
import { commandMatches } from "../src/shared/prompt-commands.ts";

test("fork and branch commands are offered while parameters and native ownership are preserved", () => {
  const catalog = deskCommandCatalog([]);
  assert.equal(commandMatches(catalog, "/fork")[0].name, "fork");
  assert.deepEqual(deskCommand("/fork abc12345 before", []), { name: "fork", args: "abc12345 before" });
  assert.deepEqual(deskCommand("/tree", []), { name: "tree", args: "" });
  assert.deepEqual(deskCommand("/compact Keep the source and pending tasks", []), { name: "compact", args: "Keep the source and pending tasks" });
  const native = [{ name: "fork", kind: "extension", description: "Project fork" }];
  assert.equal(deskCommandCatalog(native).filter(command => command.name === "fork").length, 1);
  assert.equal(deskCommand("/fork argument", native), undefined);
  assert.equal(deskCommand("/fast ultrafast", [{ name: "fast", kind: "extension", description: "Speed" }]), undefined);
});
