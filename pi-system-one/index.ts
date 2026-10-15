import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUIDANCE = "### Classifier models\n"
  + "For the same judgement over many items (screening records, counting how often something happens), call `models.classify` from codemode: "
  + "System One models such as `typesafe/jev-latest` answer typed questions (option, yes/no, score) with probabilities, for a fraction of a cent per item.";

export default function systemOne(pi: ExtensionAPI) {
  pi.on("before_agent_start", event => {
    const options = event.systemPromptOptions;
    if (!options.selectedTools.includes("codemode")) return;
    options.appendSystemPrompt = options.appendSystemPrompt ? `${options.appendSystemPrompt}\n\n${GUIDANCE}` : GUIDANCE;
  });
}
