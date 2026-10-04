/** Download interception is confined to the task-owned renderer. */
export const DOT_DOWNLOADS = String.raw`(() => {
  if (window.__piDeskDotDownloads) return;
  const urls = new Map(), files = new Map();
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, click = HTMLAnchorElement.prototype.click;
  const prune = () => { for (const [id, file] of files) if (Date.now() - file.created > 3600000) files.delete(id); };
  URL.createObjectURL = function(blob) {
    const url = create.call(URL, blob);
    if (blob instanceof Blob) { urls.set(url, new WeakRef(blob)); if (urls.size > 512) urls.delete(urls.keys().next().value); }
    return url;
  };
  URL.revokeObjectURL = function(url) { urls.delete(url); return revoke.call(URL, url); };
  const capture = anchor => {
    if (!anchor.href.startsWith('blob:') || !anchor.hasAttribute('download')) return false;
    prune(); const blob = urls.get(anchor.href)?.deref();
    if (!blob) throw Error('Native download expired. Open the attachment again.');
    if (files.size >= 16) throw Error('Finish current downloads before opening more files.');
    const id = crypto.randomUUID();
    files.set(id, { id, name: anchor.download || 'Download', mime: blob.type || 'application/octet-stream', size: blob.size, blob, created: Date.now() });
    return true;
  };
  HTMLAnchorElement.prototype.click = function() { if (!capture(this)) return click.call(this); };
  document.addEventListener('click', event => {
    const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement);
    if (anchor && capture(anchor)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.__piDeskDotDownloads = {
    list: () => { prune(); return [...files.values()].map(({blob, created, ...file}) => file); },
    remove: id => files.delete(id),
    async chunk(id, offset) {
      prune(); const file = files.get(id);
      if (!file || !Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw Error('Native download is unavailable.');
      const bytes = new Uint8Array(await file.blob.slice(offset, offset + 256 * 1024).arrayBuffer());
      let binary = ''; for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
      return { data: btoa(binary), next: offset + bytes.length, size: file.size };
    }
  };
})()`;
