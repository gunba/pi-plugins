import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUIDANCE = "### Classifier models\n"
  + "System One classifier models answer typed questions (pick an option, yes or no, or a score) with probabilities instead of text, "
  + "for a fraction of a cent per item. Call them from codemode with `models.classify`; TypeSafe's `typesafe/jev-latest` is the usual choice. "
  + "Use them when a task needs the same judgement over many items, such as screening conversations, sessions or records, "
  + "or counting how often something happens.";

export default function systemOne(pi: ExtensionAPI) {
  pi.on("before_agent_start", event => {
    const options = event.systemPromptOptions;
    if (!options.selectedTools.includes("codemode")) return;
    options.appendSystemPrompt = options.appendSystemPrompt ? `${options.appendSystemPrompt}\n\n${GUIDANCE}` : GUIDANCE;
  });
}
