# OpenAI image models

Adds GPT Image 2.5 Sunburst and Flare to Pi's native image-model catalog, including
their `2026-09-08` snapshots. Sunburst emphasizes precise editing; Flare emphasizes
speed. Generation and editing use `models.generateImages` in codemode, not a
separate `image_gen` tool. The working conversation can use another provider.

## Connections

- `openai`: an OpenAI API key, through the public Images API.
- `openai-codex`: the legacy ChatGPT Codex connection, through its image service.
  Account access and allowance still apply.

The newer **Sign in with ChatGPT** flow on `openai` does **not** support image
generation. Image models are hidden for that credential, and explicitly calling
one fails before sending an image request. It never silently switches accounts,
falls back to an environment API key, or changes the billing path. See OpenAI's
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Pi owns credentials and refresh. Provider authentication, chat/classifier models,
endpoint overrides, and request hooks remain in place. The package loads this
extension before Codex Wire, so Wire's provider replacement and restoration retain
image operations. Image calls do not use the working chat's transport or cache.

## Use

List available image models before choosing a connection:

```js
const available = await models.getAvailableOfType("image");
text(available.map(({ provider, id }) => ({ provider, id })));
```

Then use a model from that list:

```js
const result = await models.generateImages(
  { provider: "openai-codex", id: "gpt-image-2.5-sunburst" },
  { input: [{ type: "text", text: "A watercolor fox in snow" }] },
);
if (result.stopReason !== "stop") throw Error(result.errorMessage);
for (const block of result.output) if (block.type === "image") image(block);
```

For an edit, include PNG, JPEG or WebP image blocks alongside the prompt, such as
`await tools.read({path: "source.png", description: "Read the image to edit."})`.
The public API accepts sixteen references; the Codex route retains the five-image
bound of its existing integration. Quality, size and background default to `auto`.
Native callers' payload hooks can change supported request fields.

`image()` displays and saves the generated image using native codemode handling.
Do not print base64 with `text()`. Generation can take minutes; do not impose a short
codemode deadline. Stopping the call aborts its HTTP request and response reader.
There are no automatic retries of potentially billable generation requests.

## Usage and limits

When the service reports a complete token breakdown, the result includes an
API-equivalent USD estimate: $5/million text input tokens, $8/million image input
tokens and $30/million output tokens. Direct Images requests have no cached-input
discount. Missing or incomplete usage is unknown, not a zero-cost call. These
estimates enter native codemode usage totals; they are not invoices or a measure
of remaining ChatGPT subscription credits. Known usage is retained even if the
returned image cannot be decoded as base64 or recognized as a supported format.

Each decoded image is bounded to 32 MiB, the JSON request to 64 MiB, the response
to 48 MiB, and error bodies to 16 KiB. Native codemode has its own output and memory
limits. Error bodies are not echoed because they can contain prompts or secrets.

## References

- [Image generation and editing](https://developers.openai.com/api/docs/guides/image-generation)
- [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- [Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
- [JSON edit references](https://developers.openai.com/api/reference/resources/images/methods/edit)

```bash
npm run typecheck
node --test tests/extension-loading.test.mjs pi-openai-images/images.test.mjs
```
