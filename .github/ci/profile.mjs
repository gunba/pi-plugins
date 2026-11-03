import { relative, sep } from "node:path";

export default async function* (events) {
  for await (const { type, data } of events) {
    if (type === "test:summary" && data.file) {
      yield "# CI_FILE_TIMING " + JSON.stringify({
        file: relative(process.cwd(), data.file).split(sep).join("/"),
        milliseconds: data.duration_ms,
      }) + "\n";
    }
  }
}
