import assert from "node:assert/strict";
import test from "node:test";
import { deskCommand, deskCommandCatalog } from "../src/client/desk-commands.ts";
import { commandMatches } from "../src/shared/prompt-commands.ts";
import { promptCommands } from "../src/host/prompt-commands.ts";

test("the command inventory includes every installed native built-in, including model and export", async () => {
  const { BUILTIN_SLASH_COMMANDS } = await import(new URL("./core/slash-commands.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const session = { extensionRunner: { getRegisteredCommands: () => [] }, promptTemplates: [] };
  const inventory = promptCommands(session, { getSkills: () => ({ skills: [] }) });
  assert.deepEqual(inventory.filter(command => command.kind === "builtin").map(command => command.name).sort(),
    BUILTIN_SLASH_COMMANDS.map(command => command.name).sort());
  assert.equal(inventory.find(command => command.name === "model").argumentHint, "<provider/model>");
  assert.equal(commandMatches(inventory, "/").length, inventory.length, "the menu does not truncate the installed inventory");
});

test("fork and branch commands are offered while parameters and native ownership are preserved", () => {
  const handlers = Object.fromEntries(["fork", "tree", "compact", "rename"].map(name => [name, { description: name, execute() {} }]));
  const catalog = deskCommandCatalog([], handlers);
  assert.equal(commandMatches(catalog, "/fork")[0].name, "fork");
  assert.deepEqual(deskCommand("/fork abc12345 before", [], handlers), { name: "fork", args: "abc12345 before" });
  assert.deepEqual(deskCommand("/tree", [], handlers), { name: "tree", args: "" });
  assert.deepEqual(deskCommand("/compact Keep the source and pending tasks", [], handlers), { name: "compact", args: "Keep the source and pending tasks" });
  assert.deepEqual(deskCommand("/rename Annual report review", [], handlers), { name: "rename", args: "Annual report review" });
  const missing = [{ name: "future-native", kind: "builtin", description: "New native action" }];
  assert.match(deskCommandCatalog(missing, handlers).find(command => command.name === "future-native").unavailable, /terminal UI/);
  assert.throws(() => deskCommand("/future-native parameters", missing, handlers), /no Desk adapter/);
  const reserved = promptCommands({ extensionRunner: { getRegisteredCommands: () => [
    { name: "fork", invocationName: "project:fork", description: "Project fork" },
  ] }, promptTemplates: [] }, { getSkills: () => ({ skills: [] }) });
  assert.equal(reserved.find(command => command.name === "fork").kind, "builtin");
  assert.equal(reserved.find(command => command.name === "project:fork").kind, "extension");
  const native = [{ name: "fork", kind: "extension", description: "Project fork" }];
  assert.equal(deskCommandCatalog(native).filter(command => command.name === "fork").length, 1);
  assert.equal(deskCommand("/fork argument", native), undefined);
  assert.equal(deskCommand("/fast ultrafast", [{ name: "fast", kind: "extension", description: "Speed" }]), undefined);
});
