const DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";
const DISABLE_EXPERIMENTAL_WARNING_RE = /(?:^|\s)--disable-warning=ExperimentalWarning(?:\s|$)/;

function installNodeOptions(env = process.env) {
  const current = env.NODE_OPTIONS ?? "";
  if (DISABLE_EXPERIMENTAL_WARNING_RE.test(current)) return;

  const trimmed = current.trim();
  env.NODE_OPTIONS = trimmed
    ? `${trimmed} ${DISABLE_EXPERIMENTAL_WARNING}`
    : DISABLE_EXPERIMENTAL_WARNING;
}

installNodeOptions();

export default function () {
  installNodeOptions();
}
