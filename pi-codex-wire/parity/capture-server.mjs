import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { appendFileSync } from "node:fs";
import { WebSocketServer } from "ws";

/** Local-only fake Responses endpoint. CONNECT terminates TLS; it never forwards traffic.
 * Callers must use scratch credentials: the log contains complete headers, bodies, and events.
 */
export async function startCapture({ catalog, log, key, cert, scenario = "tool", sse = false }) {
  const records = [];
  const record = value => { records.push(value); appendFileSync(log, JSON.stringify(value) + "\n"); };
  let sequence = 0, toolSent = false;
  function events(body) {
    const id = `resp_capture_${++sequence}`;
    if (body.generate === false) return [
      { type: "response.created", response: { id } },
      { type: "response.completed", response: { id, status: "completed", output: [] } },
    ];
    if (scenario === "model-not-found") return [{ type: "response.failed", response: {
      id, status: "failed", error: { code: "model_not_found", message: "Capture model is unavailable." },
    } }];
    const flatten = tools => (tools ?? []).flatMap(tool => tool.type === "namespace" ? flatten(tool.tools) : [tool]);
    const tools = flatten([...(body.tools ?? []), ...(body.input ?? []).filter(item => item.type === "additional_tools").flatMap(item => item.tools)]);
    const shell = tools.find(tool => ["exec_command", "bash"].includes(tool.name));
    const output = [];
    if (scenario === "missing-ids") output.push({ type: "reasoning", summary: [], encrypted_content: "capture-reasoning" });
    if (!toolSent && scenario !== "text" && shell) {
      toolSent = true;
      output.push({ type: "function_call", name: shell.name, ...(catalog.models[0].use_responses_lite ? { namespace: "functions" } : {}),
        call_id: "call_capture", arguments: JSON.stringify(
        shell.name === "bash" ? { command: "printf parity" } : { cmd: "printf parity", max_output_tokens: 32 }), status: "completed" });
    } else output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: "parity" }], phase: "final_answer", status: "completed" });
    if (scenario !== "missing-ids") output.forEach((item, index) => { item.id = `${item.type === "message" ? "msg" : "fc"}_capture_${sequence}_${index}`; });
    const result = [{ type: "response.created", response: { id, status: "in_progress", output: [] } }];
    output.forEach((item, output_index) => {
      result.push({ type: "response.output_item.added", output_index, item: { ...item, ...(item.type === "message" ? { content: [] } : {}), status: "in_progress" } });
      if (item.type === "message") result.push({ type: "response.output_text.delta", output_index, content_index: 0, delta: "parity", ...(item.id ? { item_id: item.id } : {}) });
      result.push({ type: "response.output_item.done", output_index, item });
    });
    result.push({ type: "response.completed", response: { id, status: "completed", output, usage: {
      input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
    } } });
    return result;
  }
  async function handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    record({ kind: "http", method: req.method, url: req.url, headers: req.headers, body });
    if (req.url.split("?")[0].endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(catalog)); return; }
    if (req.method === "POST" && req.url.endsWith("/responses")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events(body)) { record({ kind: "event", transport: "sse", event }); res.write(`data: ${JSON.stringify(event)}\n\n`); }
      res.end(); return;
    }
    res.writeHead(404); res.end();
  }
  const servers = [httpServer((req, res) => { handle(req, res).catch(error => { res.destroy(error); }); })];
  if (key && cert) servers.push(httpsServer({ key, cert }, (req, res) => { handle(req, res).catch(error => { res.destroy(error); }); }));
  const wss = new WebSocketServer({ noServer: true });
  for (const server of servers) server.on("upgrade", (req, socket, head) => {
    record({ kind: "upgrade", url: req.url, headers: req.headers });
    if (sse) { socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, ws => ws.on("message", data => {
      const body = JSON.parse(data.toString());
      record({ kind: "websocket", body });
      for (const event of events(body)) { record({ kind: "event", transport: "websocket", event }); ws.send(JSON.stringify(event)); }
    }));
  });
  const sockets = new Set();
  servers[0].on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  servers[0].on("connect", (req, socket, head) => {
    if (req.url !== "chatgpt.com:443" || servers.length !== 2) { socket.destroy(); return; }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    servers[1].emit("connection", socket);
  });
  await new Promise(resolve => servers[0].listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${servers[0].address().port}`, records,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => servers[0].close(resolve));
      wss.close();
    } };
}
