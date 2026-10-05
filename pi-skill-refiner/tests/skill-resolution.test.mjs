import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { resolveSkill } = await createJiti(import.meta.url).import("../sources.ts");

test("skill-name substrings do not disambiguate an improvement query", () => {
  const skills = ["a", "b"].map(name => ({ name, description: "verification", filePath: `/fixture/${name}/SKILL.md` }));
  assert.throws(() => resolveSkill("improve verification", skills), /Specify the target skill/);
  const named = ["review", "code-review"].map(name => ({ name, description: "review code", filePath: `/fixture/${name}/SKILL.md` }));
  assert.equal(resolveSkill("improve code-review", named).name, "code-review");
});
