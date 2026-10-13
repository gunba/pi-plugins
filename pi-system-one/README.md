# System One

Adds one codemode tool, `classify`. It asks a System One classifier model the
same typed questions about each item and returns probabilities: `choice` (pick
one option), `bool` (yes or no) or `score` (a level on a scale). The tool's
description tells the agent when to use it, so tasks such as complaint counts or
skill reviews can use it without a special-purpose plugin.

The default model is TypeSafe's `jev-latest`. Sign in with `/login typesafe` or
set `TYPESAFE_API_KEY`. Pass `model` as `provider/id` to use another classifier
with credentials, for example one through OpenRouter or a llama.cpp router.

```js
const result = await tools.classify({
  input: "/tmp/messages.jsonl",
  output: "/tmp/messages.classified.jsonl",
  questions: {
    complaint: {
      type: "bool",
      instructions: "Is the developer complaining about something the agent did?",
      criteria: { true: "Objects to the agent's work or behaviour", false: "Instructions, questions, thanks or neutral updates" },
    },
  },
});
```

Small batches can pass `items` instead and get `results` back in order. Each
run reports how many items failed, a summary for each question, and the cost
at the model's catalog price. Eight items are classified at a time. Codemode's
`models.classify` remains available for single items, including images.
