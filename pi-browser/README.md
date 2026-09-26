# Browser

The `browse` skill uses `@narumitw/pi-chrome-devtools`, a native Pi extension.
There is no browser runtime or MCP server in this repository.

## Connect Chrome

Install the published native package:

```sh
pi install npm:@narumitw/pi-chrome-devtools@0.53.4
```

Chrome must expose classic CDP HTTP discovery (`/json/version` and
`/json/list`). Launch it with `--remote-debugging-port=9222` and a non-default
`--user-data-dir`; current Chrome requires the latter for command-line debugging.
This mode does not ask for approval on each debugger connection.

Chrome's permission-based debugging toggle is a different connection mode and
is not supported by this package version. No local package patch is required
for classic CDP. To reuse existing browser data, migrate the complete data
directory while Chrome is closed, retaining a backup and checking sign-ins
afterward. Pointing at an empty directory instead creates a separate profile.

To attach to a user-started browser, use
`~/.pi/agent/pi-chrome-devtools.json`:

```json
{
  "browser": {
    "endpoint": "http://127.0.0.1:9222",
    "autoLaunch": false
  },
  "webmcp": {
    "enabled": false
  }
}
```

Reload Pi after configuration changes. Automatic browser launch is disabled
here, so an unavailable endpoint does not open a different, unauthenticated
profile. Keep the endpoint on loopback. A connection grants access to the
browser profile's authenticated pages.

`/chrome-devtools` manages connection settings and tool availability.
`chrome_devtools_load` exposes capabilities on demand where Pi and the selected
model support deferred tools. Otherwise the allowed capabilities are eager.

## Tabs and observations

Use explicit string `pageId` values. Without one, tools select the current or
first available tab. Navigation creates a tab only when none is available.
For task-owned tabs, use `PUT /json/new?<encoded-url>` and
`GET /json/close/<target-id>` on the configured CDP endpoint. Preserve unrelated
tabs. The native navigate tool does not have separate new/close actions.

Scoped JavaScript observations and DOM interactions use
`chrome_devtools_evaluate`; screenshots support visual checks. Large text uses
[Pi's output archive](../pi-output-budget/README.md). There is no snapshot-diff
formatter.

Screenshot files are restricted to the working directory or OS temporary
directory. Experimental page-provided WebMCP tools are disabled.

References:

- [Native package](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-chrome-devtools)
- [Browser connection requirements](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-chrome-devtools/docs/browser-setup.md)
- [Chrome debugging-directory requirement](https://developer.chrome.com/blog/remote-debugging-port)
