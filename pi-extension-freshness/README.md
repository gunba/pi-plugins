# pi-extension-freshness

Shows a startup freshness panel for loaded Pi extensions with their last updated date and age.

Dates come from the most recent git commit that touched each extension path,
with file modification time as the local fallback. Green means updated within
30 days, yellow means 30–180 days, red means more than 180 days, and muted
styling marks unknown dates.

Use `/extension-freshness` to show the panel again in the current session.
