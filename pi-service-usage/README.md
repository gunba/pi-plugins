# Service usage

`service-usage.sqlite` in Pi's agent directory records API-price estimates on this computer. Daily aggregates keep storage bounded by services and days rather than classifier batch size. Separate processes share it through SQLite transactions.

- Exa: `costDollars.total` for every API request, including successful requests in a batch that later fails.
- Native classifiers and image generation: returned usage costs in Desk workers and SDK child agents. Codemode also includes its model costs in native conversation usage; background callers such as watch classifiers may not. The service table is not an additional-charge total.
- ElevenLabs: full audio duration, preferring `audio_duration_secs` from the service and falling back to the browser's recorded duration, multiplied by configured rates. Silence is included. Defaults follow the [API pricing page](https://elevenlabs.io/pricing/api): $0.22 per audio hour, plus $0.05/hour when keyterms are used. Rates can be changed for the account's plan.

Unknown costs remain unknown, including requests with uncertain outcomes. They are not treated as free. Estimates do not reconcile provider invoices, subscription credits, taxes, discounts, or usage outside the instrumented paths. Earlier usage is not reconstructed. Terminal Exa calls are included; terminal classifier/image calls outside the SDK child driver are not.

Only service identifiers, operation names, dates, counts, durations, and costs are stored. Keys, prompts, transcripts, audio, and URLs are not recorded. Recording failures must not cause a successful paid request to be retried.
