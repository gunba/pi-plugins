# pi-startup-env

Sets Pi startup environment defaults before package extensions run.

## Behaviour

- Adds `--disable-warning=ExperimentalWarning` to `NODE_OPTIONS` if it is not already present.
- Leaves existing `NODE_OPTIONS` values intact.
- Runs at module load and again when Pi calls the extension factory, so child Node processes spawned during extension startup inherit the setting.

## Load order

Install this as a top-level Pi extension path through `settings.json` `extensions`, for example:

```json
{
  "extensions": [
    "../../Desktop/Projects/pi-plugins/pi-startup-env"
  ]
}
```

Top-level user/project extension entries load before package resources, which keeps package-managed child processes from printing startup warnings into the TUI.
