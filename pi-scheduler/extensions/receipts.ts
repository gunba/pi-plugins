import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export const SCHEDULED_MESSAGE_TYPE = "pi-scheduler-scheduled-message";
type Stamp = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };

/** Index append-only JSONL receipts; reset on session lifecycle rewrites. */
export class DeliveryReceipts {
  private file?: string;
  private stamp?: Stamp;
  private offset = 0;
  private anchor = Buffer.alloc(0);
  private ids = new Set<string>();

  reset(): void {
    this.file = undefined;
    this.stamp = undefined;
    this.offset = 0;
    this.anchor = Buffer.alloc(0);
    this.ids = new Set();
  }

  read(file: string): ReadonlySet<string> {
    let fd: number;
    try { fd = openSync(file, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.reset();
      return this.ids;
    }
    try {
      const stat = fstatSync(fd, { bigint: true });
      const old = this.stamp;
      if (this.file !== file || !old || old.dev !== stat.dev || old.ino !== stat.ino || stat.size < old.size
        || (stat.size === old.size && (stat.mtimeNs !== old.mtimeNs || stat.ctimeNs !== old.ctimeNs))) this.reset();
      if (this.stamp?.size === stat.size && this.stamp.mtimeNs === stat.mtimeNs && this.stamp.ctimeNs === stat.ctimeNs) return this.ids;
      // Detect an in-place rewrite at the last committed boundary as well as
      // replacement/truncation. Lifecycle hooks invalidate other core rewrites.
      if (this.offset) {
        const anchor = Buffer.alloc(this.anchor.length);
        const read = readSync(fd, anchor, 0, anchor.length, this.offset - anchor.length);
        if (read !== anchor.length || !anchor.equals(this.anchor)) this.reset();
      }
      let position = this.offset, complete = this.offset;
      const additions = new Set<string>();
      let fragments: Buffer[] = [];
      const size = Number(stat.size);
      while (position < size) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - position));
        const read = readSync(fd, chunk, 0, chunk.length, position);
        if (!read) throw new Error("Session changed while reading scheduler receipts");
        let start = 0;
        for (let end = chunk.indexOf(10); end !== -1 && end < read; end = chunk.indexOf(10, start)) {
          fragments.push(chunk.subarray(start, end));
          const line = Buffer.concat(fragments).toString("utf8").trim();
          if (line) {
            const entry = JSON.parse(line);
            if (entry?.type === "custom_message" && entry.customType === SCHEDULED_MESSAGE_TYPE
              && typeof entry.details?.id === "string") additions.add(entry.details.id);
          }
          fragments = [];
          start = end + 1;
          complete = position + start;
        }
        if (start < read) fragments.push(chunk.subarray(start, read));
        position += read;
      }
      // Unfinished appends are reread from the last complete newline, not admitted.
      const anchor = Buffer.alloc(Math.min(256, complete));
      if (anchor.length && readSync(fd, anchor, 0, anchor.length, complete - anchor.length) !== anchor.length)
        throw new Error("Session changed while reading scheduler receipts");
      for (const id of additions) this.ids.add(id);
      this.offset = complete;
      this.anchor = anchor;
      this.file = file;
      this.stamp = stat;
      return this.ids;
    } finally { closeSync(fd); }
  }
}
