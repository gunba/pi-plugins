import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUIDANCE = "### Classifier models\n"
  + "For one judgement over many items, call `models.classify` from codemode with `typesafe/jev-latest`: "
  + "typed answers (option, yes/no, score) with probabilities, a fraction of a cent per item.";

export default function systemOne(pi: ExtensionAPI) {
  pi.on("before_agent_start", event => {
    const options = event.systemPromptOptions;
    if (!options.selectedTools.includes("codemode")) return;
    options.appendSystemPrompt = options.appendSystemPrompt ? `${options.appendSystemPrompt}\n\n${GUIDANCE}` : GUIDANCE;
  });
}
