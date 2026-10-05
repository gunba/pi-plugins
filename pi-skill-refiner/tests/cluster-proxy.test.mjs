import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cluster = fileURLToPath(new URL("../cluster.py", import.meta.url));

test("hosted embeddings honor normal proxy discovery without changing redirects or TLS", (t) => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-B", "-c", `
import importlib.util
import io
import ssl
import sys
import unittest
import urllib.request
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("refiner_cluster", sys.argv[1])
cluster = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cluster)
proxies = {"https": "http://proxy.invalid:3128"}
captured = []

def fake_open(opener, request, timeout):
    captured.append(opener)
    assert request.full_url == cluster.ENDPOINT
    assert timeout == 120
    return io.BytesIO(b'{"synthetic": true}')

# Keep real TLS verification defaults, but don't enumerate the machine's certificate stores.
# Proxy discovery and transport are mocked too; no settings, keys or network are used.
with patch.object(ssl.SSLContext, "load_default_certs"), patch.object(urllib.request, "getproxies", return_value=proxies) as discover:
    with patch.object(urllib.request.OpenerDirector, "open", autospec=True, side_effect=fake_open):
        assert cluster.request({"input": ["Synthetic summary."]}, "synthetic-key") == {"synthetic": True}
    discover.assert_called_once_with()

assert len(captured) == 1
handlers = captured[0].handlers
proxy = next(handler for handler in handlers if isinstance(handler, urllib.request.ProxyHandler))
assert proxy.proxies == proxies
https = next(handler for handler in handlers if type(handler) is urllib.request.HTTPSHandler)
if https._context is not None:
    assert https._context.verify_mode == ssl.CERT_REQUIRED
    assert https._context.check_hostname
redirect = next(handler for handler in handlers if type(handler).__name__ == "NoRedirect")
with unittest.TestCase().assertRaisesRegex(RuntimeError, "redirect refused"):
    redirect.redirect_request(None, None, 302, "Found", {}, "https://other.invalid")
print("proxy regression passed")
`, cluster], { encoding: "utf8", timeout: 30_000 });
  if (result.error?.code === "ENOENT") {
    t.skip("Python is unavailable; this regression uses only its standard library");
    return;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /proxy regression passed/);
});
