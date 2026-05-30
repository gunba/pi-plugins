import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

type SurfaceTool = "pi" | "claude" | "codex" | "mcp" | "subagents" | "generic";
type FileFormat = "json" | "toml" | "markdown" | "text";
type EntryKind = "settings" | "context" | "skill" | "prompt" | "extension" | "mcp" | "agent" | "model" | "hook" | "resource";
type FieldType = "boolean" | "string" | "number" | "enum" | "stringArray" | "stringMap" | "object";

type ConfigEntry = {
  id: string;
  title: string;
  group: string;
  kind: EntryKind;
  tool: SurfaceTool;
  path: string;
  format: FileFormat;
  scope: "global" | "project" | "workspace" | "package" | "compat";
  loaded?: boolean;
  createTemplate?: () => string;
  note?: string;
};

type SettingField = {
  key: string;
  label: string;
  type: FieldType;
  description: string;
  defaultValue: unknown;
  choices?: string[];
};

type EnvVarField = {
  name: string;
  description: string;
  valueHint?: string;
  tools: SurfaceTool[];
};

const EXTENSION_NAME = "pi-config";
const MAX_WALK_DEPTH = 6;
const MAX_WALK_FILES = 400;

const PI_SETTINGS: SettingField[] = [
  field("defaultProvider", "Default provider", "string", "Default model provider, e.g. anthropic, openai, google, github-copilot.", ""),
  field("defaultModel", "Default model", "string", "Default model id for new sessions.", ""),
  field("defaultThinkingLevel", "Default thinking level", "enum", "Default reasoning level.", "medium", ["off", "minimal", "low", "medium", "high", "xhigh"]),
  field("hideThinkingBlock", "Hide thinking block", "boolean", "Hide thinking blocks in output.", false),
  field("thinkingBudgets", "Thinking budgets", "object", "Custom token budgets per thinking level.", { minimal: 1024, low: 4096, medium: 10240, high: 32768 }),
  field("theme", "Theme", "string", "Theme name, e.g. dark, light, or a custom theme.", "dark"),
  field("quietStartup", "Quiet startup", "boolean", "Hide startup header.", false),
  field("collapseChangelog", "Collapse changelog", "boolean", "Show condensed changelog after updates.", false),
  field("enableInstallTelemetry", "Install telemetry", "boolean", "Send anonymous install/update version ping.", true),
  field("doubleEscapeAction", "Double escape action", "enum", "Action for double escape.", "tree", ["tree", "fork", "none"]),
  field("treeFilterMode", "Tree filter mode", "enum", "Default filter for /tree.", "default", ["default", "no-tools", "user-only", "labeled-only", "all"]),
  field("editorPaddingX", "Editor padding X", "number", "Horizontal padding for input editor, 0-3.", 0),
  field("autocompleteMaxVisible", "Autocomplete max visible", "number", "Max visible autocomplete rows, 3-20.", 5),
  field("showHardwareCursor", "Show hardware cursor", "boolean", "Show terminal cursor while TUI positions it for IME support.", false),
  field("warnings.anthropicExtraUsage", "Anthropic extra usage warning", "boolean", "Show Anthropic subscription paid-extra-usage warning.", true),
  field("compaction.enabled", "Compaction enabled", "boolean", "Enable automatic compaction.", true),
  field("compaction.reserveTokens", "Compaction reserve tokens", "number", "Tokens reserved for LLM response during compaction.", 16384),
  field("compaction.keepRecentTokens", "Compaction keep recent tokens", "number", "Recent tokens to keep unsummarized.", 20000),
  field("branchSummary.reserveTokens", "Branch summary reserve tokens", "number", "Tokens reserved for branch summarization.", 16384),
  field("branchSummary.skipPrompt", "Branch summary skip prompt", "boolean", "Skip branch summary prompt on tree navigation.", false),
  field("retry.enabled", "Retry enabled", "boolean", "Enable automatic agent-level retry on transient errors.", true),
  field("retry.maxRetries", "Retry max retries", "number", "Maximum agent-level retry attempts.", 3),
  field("retry.baseDelayMs", "Retry base delay", "number", "Base delay for exponential retry backoff.", 2000),
  field("retry.provider.timeoutMs", "Provider timeout", "number", "Provider/SDK request timeout in milliseconds.", 3600000),
  field("retry.provider.maxRetries", "Provider max retries", "number", "Provider-level retry attempts.", 0),
  field("retry.provider.maxRetryDelayMs", "Provider max retry delay", "number", "Cap server-requested retry delay before failing.", 60000),
  field("steeringMode", "Steering mode", "enum", "How steering messages are delivered.", "one-at-a-time", ["all", "one-at-a-time"]),
  field("followUpMode", "Follow-up mode", "enum", "How follow-up messages are delivered.", "one-at-a-time", ["all", "one-at-a-time"]),
  field("transport", "Provider transport", "enum", "Preferred transport for providers that support multiple transports.", "auto", ["auto", "sse", "websocket", "websocket-cached"]),
  field("httpIdleTimeoutMs", "HTTP idle timeout", "number", "HTTP header/body idle timeout in milliseconds; 0 disables.", 300000),
  field("websocketConnectTimeoutMs", "WebSocket connect timeout", "number", "WebSocket open handshake timeout in milliseconds; 0 disables.", 15000),
  field("terminal.showImages", "Show terminal images", "boolean", "Show images inline when the terminal supports it.", true),
  field("terminal.imageWidthCells", "Terminal image width", "number", "Preferred inline image width in terminal cells.", 60),
  field("terminal.clearOnShrink", "Terminal clear on shrink", "boolean", "Clear empty rows when rendered content shrinks.", false),
  field("images.autoResize", "Auto-resize images", "boolean", "Resize images to model-friendly dimensions.", true),
  field("images.blockImages", "Block images", "boolean", "Block all images from being sent to the LLM.", false),
  field("shellPath", "Shell path", "string", "Custom shell path.", ""),
  field("shellCommandPrefix", "Shell command prefix", "string", "Prefix prepended to every bash command.", ""),
  field("npmCommand", "NPM command", "stringArray", "Command argv used for Pi package operations.", ["npm"]),
  field("sessionDir", "Session directory", "string", "Directory where session files are stored.", ""),
  field("enabledModels", "Enabled models", "stringArray", "Model patterns for Ctrl+P model cycling.", []),
  field("markdown.codeBlockIndent", "Markdown code block indent", "string", "Indentation for rendered code blocks.", "  "),
  field("packages", "Packages", "stringArray", "NPM/git packages to load Pi resources from.", []),
  field("extensions", "Extension paths", "stringArray", "Local extension file paths or directories.", []),
  field("skills", "Skill paths", "stringArray", "Local skill file paths or directories.", []),
  field("prompts", "Prompt paths", "stringArray", "Local prompt template paths or directories.", []),
  field("themes", "Theme paths", "stringArray", "Local theme file paths or directories.", []),
  field("enableSkillCommands", "Enable skill commands", "boolean", "Register skills as /skill:name commands.", true),
  field("subagents", "Subagents config", "object", "pi-subagents overrides and defaults when that package is installed.", {}),
];

const CLAUDE_SETTINGS: SettingField[] = [
  field("env", "Environment variables", "stringMap", "Environment variables passed to Claude Code.", {}),
  field("permissions", "Permissions", "object", "Permission rules with allow/deny arrays of tool patterns.", { allow: [], deny: [] }),
  field("hooks", "Hooks", "object", "Claude Code event hooks configuration.", {}),
  field("enabledPlugins", "Enabled plugins", "object", "Enabled Claude Code plugin configuration by plugin identifier.", {}),
  field("includeCoAuthoredBy", "Include co-authored-by", "boolean", "Add Claude co-author trailer to commits when supported.", false),
  field("statusLine", "Status line", "object", "Custom Claude Code status line command/configuration.", {}),
  field("model", "Model", "string", "Preferred Claude Code model.", ""),
];

const CODEX_SETTINGS: SettingField[] = [
  field("model", "Model", "string", "Preferred Codex model.", ""),
  field("model_provider", "Model provider", "string", "Provider entry to use from model_providers.", ""),
  field("approval_policy", "Approval policy", "enum", "When Codex asks for user approval.", "on-request", ["untrusted", "on-failure", "on-request", "never"]),
  field("sandbox_mode", "Sandbox mode", "enum", "Filesystem/network sandbox policy.", "workspace-write", ["read-only", "workspace-write", "danger-full-access"]),
  field("disable_response_storage", "Disable response storage", "boolean", "Ask provider not to store responses when supported.", false),
  field("hide_agent_reasoning", "Hide agent reasoning", "boolean", "Hide reasoning summaries in the UI.", false),
  field("model_providers", "Model providers", "object", "Custom provider definitions.", {}),
  field("mcp_servers", "MCP servers", "object", "Codex MCP server definitions.", {}),
  field("profiles", "Profiles", "object", "Named Codex configuration profiles.", {}),
  field("shell_environment_policy", "Shell environment policy", "object", "Environment inheritance and explicit env var policy.", { inherit: "all", set: {} }),
  field("notify", "Notify", "stringArray", "Command argv for desktop notifications.", []),
  field("preferred_auth_method", "Preferred auth method", "string", "Authentication preference where supported.", ""),
];

const MCP_SETTINGS: SettingField[] = [
  field("mcpServers", "MCP servers", "object", "Top-level MCP server definitions.", {}),
  field("settings", "Adapter settings", "object", "pi-mcp-adapter global settings.", {}),
  field("imports", "Import sources", "stringArray", "Import MCP configs from other tools.", []),
];

const ENV_VARS: EnvVarField[] = [
  env("ANTHROPIC_API_KEY", "Anthropic API key for Claude models.", ["pi", "claude"], "sk-ant-..."),
  env("OPENAI_API_KEY", "OpenAI API key for OpenAI/Codex models and OpenAI-compatible clients.", ["pi", "codex"], "sk-..."),
  env("GITHUB_TOKEN", "GitHub token used by GitHub APIs and some MCP servers.", ["pi", "mcp", "codex", "claude"]),
  env("GOOGLE_API_KEY", "Google AI API key.", ["pi"], "AIza..."),
  env("GEMINI_API_KEY", "Gemini API key used by several tools.", ["pi"], "AIza..."),
  env("GROQ_API_KEY", "Groq API key.", ["pi"]),
  env("OPENROUTER_API_KEY", "OpenRouter API key.", ["pi"]),
  env("PERPLEXITY_API_KEY", "Perplexity API key for web/search tools.", ["mcp", "pi"]),
  env("EXA_API_KEY", "Exa API key for web/search tools.", ["mcp", "pi"]),
  env("BRAVE_API_KEY", "Brave Search API key.", ["mcp", "pi"]),
  env("PI_CODING_AGENT_DIR", "Override Pi's global agent directory.", ["pi"]),
  env("PI_CODING_AGENT_SESSION_DIR", "Override Pi session directory.", ["pi"]),
  env("PI_OFFLINE", "Disable startup network operations when set to 1.", ["pi"], "1"),
  env("PI_SKIP_VERSION_CHECK", "Disable Pi version update check.", ["pi"], "1"),
  env("PI_TELEMETRY", "Set to 0 to opt out of Pi install/update telemetry.", ["pi"], "0"),
  env("PI_HARDWARE_CURSOR", "Set to 1 to show terminal hardware cursor for IME positioning.", ["pi"], "1"),
  env("PI_ASK_USER_DISPLAY_MODE", "Default pi-ask-user display mode.", ["pi"], "inline"),
  env("PI_MEMEDIT", "Enable/disable pi-memedit if installed.", ["pi"], "off"),
  env("CODEX_HOME", "Override OpenAI Codex config home in tools that respect it.", ["codex"]),
  env("CLAUDE_CONFIG_DIR", "Override Claude config directory in tools that respect it.", ["claude"]),
  env("MCP_CONFIG", "Custom MCP config path used by some MCP launchers.", ["mcp"]),
];

function field(key: string, label: string, type: FieldType, description: string, defaultValue: unknown, choices?: string[]): SettingField {
  return { key, label, type, description, defaultValue, choices };
}

function env(name: string, description: string, tools: SurfaceTool[], valueHint?: string): EnvVarField {
  return { name, description, tools, valueHint };
}

function piAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  return expandPath(configured, homedir());
}

function expandPath(value: string, baseDir: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  if (isAbsolute(value)) return resolve(value);
  return resolve(baseDir, value);
}

function displayPath(path: string, cwd: string): string {
  const abs = resolve(path);
  const home = homedir();
  if (abs === cwd) return ".";
  const rel = relative(cwd, abs);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel || ".";
  if (abs === home) return "~";
  if (abs.startsWith(home + "/")) return `~/${abs.slice(home.length + 1)}`;
  return abs;
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function dirExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readText(path: string, fallback = ""): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

function writeTextAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const existingMode = fileExists(path) ? statSync(path).mode & 0o777 : undefined;
  const defaultMode = path.endsWith(".json") || path.endsWith(".toml") ? 0o600 : 0o644;
  const mode = existingMode ?? defaultMode;
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, text, { encoding: "utf8", mode });
  renameSync(tmp, path);
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function jsonTemplate(): string {
  return "{}\n";
}

function tomlTemplate(): string {
  return "";
}

function markdownTemplate(title: string): string {
  return `# ${title}\n\n`;
}

function skillTemplate(name: string): string {
  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "new-skill";
  return `---\nname: ${safeName}\ndescription: TODO: Describe what this skill does and when to use it.\n---\n\n# ${safeName}\n\n## Instructions\n\nTODO\n`;
}

function inferFormat(path: string): FileFormat {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".toml")) return "toml";
  if (path.endsWith(".md")) return "markdown";
  return "text";
}

function makeEntry(input: Omit<ConfigEntry, "id">): ConfigEntry {
  return { ...input, id: `${input.kind}:${input.tool}:${input.scope}:${resolve(input.path)}` };
}

function addEntry(entries: ConfigEntry[], seen: Set<string>, entry: ConfigEntry): void {
  const key = `${entry.kind}:${resolve(entry.path)}`;
  const existing = entries.find((candidate) => `${candidate.kind}:${resolve(candidate.path)}` === key);
  if (existing) {
    existing.loaded ||= entry.loaded;
    if (!existing.note && entry.note) existing.note = entry.note;
    return;
  }
  if (seen.has(key)) return;
  seen.add(key);
  entries.push(entry);
}

function ancestorDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);
  while (true) {
    dirs.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function discoverEntries(pi: ExtensionAPI, ctx: ExtensionCommandContext): ConfigEntry[] {
  const cwd = ctx.cwd;
  const agentDir = piAgentDir();
  const entries: ConfigEntry[] = [];
  const seen = new Set<string>();

  const add = (entry: Omit<ConfigEntry, "id">) => addEntry(entries, seen, makeEntry(entry));

  add({ title: "Pi global settings", group: "Pi settings", kind: "settings", tool: "pi", path: join(agentDir, "settings.json"), format: "json", scope: "global", createTemplate: jsonTemplate, loaded: true });
  add({ title: "Pi project settings", group: "Pi settings", kind: "settings", tool: "pi", path: join(cwd, ".pi", "settings.json"), format: "json", scope: "project", createTemplate: jsonTemplate, loaded: true });
  add({ title: "Pi custom models", group: "Pi settings", kind: "model", tool: "pi", path: join(agentDir, "models.json"), format: "json", scope: "global", createTemplate: jsonTemplate, loaded: true });
  add({ title: "Pi project custom models", group: "Pi settings", kind: "model", tool: "pi", path: join(cwd, ".pi", "models.json"), format: "json", scope: "project", createTemplate: jsonTemplate });

  add({ title: "Claude global settings", group: "Claude Code compatibility", kind: "settings", tool: "claude", path: join(homedir(), ".claude", "settings.json"), format: "json", scope: "compat", createTemplate: jsonTemplate });
  add({ title: "Claude project settings", group: "Claude Code compatibility", kind: "settings", tool: "claude", path: join(cwd, ".claude", "settings.json"), format: "json", scope: "compat", createTemplate: jsonTemplate });
  add({ title: "Claude project local settings", group: "Claude Code compatibility", kind: "settings", tool: "claude", path: join(cwd, ".claude", "settings.local.json"), format: "json", scope: "compat", createTemplate: jsonTemplate });
  add({ title: "Claude project hooks", group: "Claude Code compatibility", kind: "hook", tool: "claude", path: join(cwd, ".claude", "hooks.json"), format: "json", scope: "compat", createTemplate: jsonTemplate });

  add({ title: "Codex global config", group: "Codex compatibility", kind: "settings", tool: "codex", path: join(homedir(), ".codex", "config.toml"), format: "toml", scope: "compat", createTemplate: tomlTemplate });
  add({ title: "Codex project config", group: "Codex compatibility", kind: "settings", tool: "codex", path: join(cwd, ".codex", "config.toml"), format: "toml", scope: "compat", createTemplate: tomlTemplate });
  add({ title: "Codex global hooks", group: "Codex compatibility", kind: "hook", tool: "codex", path: join(homedir(), ".codex", "hooks.json"), format: "json", scope: "compat", createTemplate: jsonTemplate });
  add({ title: "Codex project hooks", group: "Codex compatibility", kind: "hook", tool: "codex", path: join(cwd, ".codex", "hooks.json"), format: "json", scope: "compat", createTemplate: jsonTemplate });

  addContextEntries(add, cwd, agentDir);
  addMcpEntries(add, cwd, agentDir, pi);
  addLoadedCommandEntries(add, pi);
  addKnownResourceEntries(add, cwd, agentDir);

  return entries.sort((a, b) => {
    const group = a.group.localeCompare(b.group);
    if (group !== 0) return group;
    const existsA = fileExists(a.path) ? 0 : 1;
    const existsB = fileExists(b.path) ? 0 : 1;
    if (existsA !== existsB) return existsA - existsB;
    return a.title.localeCompare(b.title);
  });
}

function addContextEntries(add: (entry: Omit<ConfigEntry, "id">) => void, cwd: string, agentDir: string): void {
  add({ title: "Pi global AGENTS.md", group: "Context files", kind: "context", tool: "pi", path: join(agentDir, "AGENTS.md"), format: "markdown", scope: "global", loaded: true, createTemplate: () => markdownTemplate("Global Instructions") });
  add({ title: "Pi global SYSTEM.md", group: "Context files", kind: "context", tool: "pi", path: join(agentDir, "SYSTEM.md"), format: "markdown", scope: "global", createTemplate: () => markdownTemplate("System Prompt") });
  add({ title: "Pi global APPEND_SYSTEM.md", group: "Context files", kind: "context", tool: "pi", path: join(agentDir, "APPEND_SYSTEM.md"), format: "markdown", scope: "global", createTemplate: () => markdownTemplate("Appended System Prompt") });

  for (const dir of ancestorDirs(cwd)) {
    const label = displayPath(dir, cwd) || basename(dir);
    for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(dir, fileName);
      if (fileExists(path) || dir === cwd) {
        add({
          title: `${fileName} at ${label}`,
          group: "Context files",
          kind: "context",
          tool: fileName === "CLAUDE.md" ? "claude" : "pi",
          path,
          format: "markdown",
          scope: dir === cwd ? "project" : "workspace",
          loaded: fileExists(path),
          createTemplate: () => markdownTemplate(`${fileName.replace(/\.md$/i, "")} Instructions`),
        });
      }
    }
    for (const fileName of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
      const path = join(dir, ".pi", fileName);
      if (fileExists(path) || dir === cwd) {
        add({
          title: `.pi/${fileName} at ${label}`,
          group: "Context files",
          kind: "context",
          tool: "pi",
          path,
          format: "markdown",
          scope: dir === cwd ? "project" : "workspace",
          loaded: fileExists(path),
          createTemplate: () => markdownTemplate(fileName.replace(/\.md$/i, "")),
        });
      }
    }
  }
}

function addMcpEntries(add: (entry: Omit<ConfigEntry, "id">) => void, cwd: string, agentDir: string, pi: ExtensionAPI): void {
  const mcpLoaded = pi.getAllTools().some((tool) => tool.name === "mcp");
  add({ title: "Shared global MCP config", group: "MCP configs", kind: "mcp", tool: "mcp", path: join(homedir(), ".config", "mcp", "mcp.json"), format: "json", scope: "global", createTemplate: () => JSON.stringify({ mcpServers: {} }, null, 2) + "\n", loaded: mcpLoaded, note: "Read by pi-mcp-adapter when installed." });
  add({ title: "Pi global MCP config", group: "MCP configs", kind: "mcp", tool: "mcp", path: join(agentDir, "mcp.json"), format: "json", scope: "global", createTemplate: () => JSON.stringify({ mcpServers: {} }, null, 2) + "\n", loaded: mcpLoaded, note: "Pi-owned pi-mcp-adapter config." });
  add({ title: "Project shared MCP config", group: "MCP configs", kind: "mcp", tool: "mcp", path: join(cwd, ".mcp.json"), format: "json", scope: "project", createTemplate: () => JSON.stringify({ mcpServers: {} }, null, 2) + "\n", loaded: mcpLoaded });
  add({ title: "Project Pi MCP config", group: "MCP configs", kind: "mcp", tool: "mcp", path: join(cwd, ".pi", "mcp.json"), format: "json", scope: "project", createTemplate: () => JSON.stringify({ mcpServers: {} }, null, 2) + "\n", loaded: mcpLoaded });
  add({ title: "Claude MCP config", group: "MCP configs", kind: "mcp", tool: "claude", path: join(homedir(), ".claude", "mcp.json"), format: "json", scope: "compat", createTemplate: () => JSON.stringify({ mcpServers: {} }, null, 2) + "\n" });
  add({ title: "Claude desktop MCP config", group: "MCP configs", kind: "mcp", tool: "claude", path: join(homedir(), ".claude", "claude_desktop_config.json"), format: "json", scope: "compat", createTemplate: () => JSON.stringify({ mcpServers: {} }, null, 2) + "\n" });
  add({ title: "Codex MCP import config", group: "MCP configs", kind: "mcp", tool: "codex", path: join(homedir(), ".codex", "config.json"), format: "json", scope: "compat", createTemplate: () => JSON.stringify({ mcpServers: {} }, null, 2) + "\n" });
}

function sourceScope(scope: string | undefined): ConfigEntry["scope"] {
  if (scope === "project") return "project";
  if (scope === "temporary") return "package";
  return "global";
}

function addLoadedCommandEntries(add: (entry: Omit<ConfigEntry, "id">) => void, pi: ExtensionAPI): void {
  for (const command of pi.getCommands()) {
    const info = command.sourceInfo;
    const path = info?.path;
    if (!path || !fileExists(path)) continue;
    const scope = sourceScope(info.scope);
    if (command.source === "skill") {
      add({ title: `Loaded skill /${command.name}`, group: "Loaded Pi resources", kind: "skill", tool: "pi", path, format: inferFormat(path), scope, loaded: true, note: info.source });
    } else if (command.source === "prompt") {
      add({ title: `Loaded prompt /${command.name}`, group: "Loaded Pi resources", kind: "prompt", tool: "pi", path, format: inferFormat(path), scope, loaded: true, note: info.source });
    } else if (command.source === "extension") {
      add({ title: `Extension command /${command.name}`, group: "Loaded Pi resources", kind: "extension", tool: "pi", path, format: inferFormat(path), scope, loaded: true, note: info.source });
    }
  }
}

function isWithin(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function scopeForResourceRoot(root: string, cwd: string, agentDir: string): ConfigEntry["scope"] {
  const home = homedir();
  if (isWithin(root, cwd)) return "project";
  if (isWithin(root, agentDir)) return "global";
  if (isWithin(root, join(home, ".agents"))) return "global";
  if (isWithin(root, join(home, ".claude")) || isWithin(root, join(home, ".codex"))) return "compat";
  return "workspace";
}

function addKnownResourceEntries(add: (entry: Omit<ConfigEntry, "id">) => void, cwd: string, agentDir: string): void {
  const hierarchy = ancestorDirs(cwd);
  const skillRoots = [
    join(agentDir, "skills"),
    join(homedir(), ".agents", "skills"),
    join(cwd, ".pi", "skills"),
    ...hierarchy.map((dir) => join(dir, ".agents", "skills")),
    join(homedir(), ".claude", "skills"),
    join(homedir(), ".codex", "skills"),
  ];
  for (const root of skillRoots) {
    const scope = scopeForResourceRoot(root, cwd, agentDir);
    for (const path of walkNamedFiles(root, (name) => name === "SKILL.md" || name.endsWith(".md"))) {
      add({ title: `Skill ${basename(dirname(path))}`, group: "Skills", kind: "skill", tool: root.includes(".claude") ? "claude" : root.includes(".codex") ? "codex" : "pi", path, format: "markdown", scope, loaded: false });
    }
  }

  const promptRoots = [join(agentDir, "prompts"), join(cwd, ".pi", "prompts")];
  for (const root of promptRoots) {
    const scope = scopeForResourceRoot(root, cwd, agentDir);
    for (const path of walkNamedFiles(root, (name) => name.endsWith(".md"))) {
      add({ title: `Prompt ${basename(path, ".md")}`, group: "Prompts", kind: "prompt", tool: "pi", path, format: "markdown", scope, loaded: false });
    }
  }

  const extensionRoots = [join(agentDir, "extensions"), join(cwd, ".pi", "extensions")];
  for (const root of extensionRoots) {
    const scope = scopeForResourceRoot(root, cwd, agentDir);
    for (const path of walkNamedFiles(root, (name) => name.endsWith(".ts") || name === "index.ts")) {
      add({ title: `Extension ${basename(path)}`, group: "Extensions", kind: "extension", tool: "pi", path, format: "text", scope, loaded: false });
    }
  }

  const agentRoots = [join(agentDir, "agents"), join(cwd, ".pi", "agents"), ...hierarchy.map((dir) => join(dir, ".agents")), join(homedir(), ".agents")];
  for (const root of agentRoots) {
    const scope = scopeForResourceRoot(root, cwd, agentDir);
    for (const path of walkNamedFiles(root, (name) => name.endsWith(".md") && name !== "SKILL.md" && !name.endsWith(".chain.md"))) {
      add({ title: `Agent ${basename(path, ".md")}`, group: "Subagent definitions", kind: "agent", tool: "subagents", path, format: "markdown", scope, loaded: false, note: "pi-subagents convention." });
    }
  }

  add({ title: "New project skill", group: "Create project resources", kind: "skill", tool: "pi", path: join(cwd, ".pi", "skills", "new-skill", "SKILL.md"), format: "markdown", scope: "project", createTemplate: () => skillTemplate("new-skill") });
  add({ title: "New project subagent", group: "Create project resources", kind: "agent", tool: "subagents", path: join(cwd, ".pi", "agents", "new-agent.md"), format: "markdown", scope: "project", createTemplate: () => markdownTemplate("New Agent") });
}

function walkNamedFiles(root: string, include: (name: string) => boolean): string[] {
  const out: string[] = [];
  if (!dirExists(root)) return out;
  const walk = (dir: string, depth: number) => {
    if (out.length >= MAX_WALK_FILES || depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_WALK_FILES) break;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && include(entry.name)) out.push(path);
    }
  };
  walk(root, 0);
  return out;
}

function matchesFilter(entry: ConfigEntry, filter: string, cwd: string): boolean {
  const haystack = [entry.title, entry.group, entry.kind, entry.tool, entry.scope, entry.note ?? "", displayPath(entry.path, cwd)].join(" ").toLowerCase();
  return filter.toLowerCase().split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
}

type PickerRow =
  | { kind: "inventory"; title: string; subtitle: string }
  | { kind: "entry"; entry: ConfigEntry };

type PickerResult = { action: "inventory" } | { action: "entry"; entry: ConfigEntry } | null;

function fitLine(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width));
  const pad = Math.max(0, width - visibleWidth(clipped));
  return `${clipped}${" ".repeat(pad)}`;
}

function boxedLine(content: string, width: number, color: (s: string) => string): string {
  if (width <= 2) return fitLine(content, width);
  return color("│") + fitLine(content, width - 2) + color("│");
}

function borderLine(width: number, left: string, fill: string, right: string, color: (s: string) => string, label?: string): string {
  if (width <= 2) return color(fill.repeat(Math.max(0, width)));
  const inner = Math.max(0, width - 2);
  if (!label || visibleWidth(label) + 2 >= inner) return color(`${left}${fill.repeat(inner)}${right}`);
  const tag = ` ${label} `;
  const rest = Math.max(0, inner - visibleWidth(tag) - 1);
  return color(`${left}${fill}`) + tag + color(`${fill.repeat(rest)}${right}`);
}

function rowTitle(row: PickerRow): string {
  return row.kind === "inventory" ? row.title : row.entry.title;
}

function rowSubtitle(row: PickerRow, cwd: string): string {
  if (row.kind === "inventory") return row.subtitle;
  const entry = row.entry;
  const status = fileExists(entry.path) ? "exists" : "missing";
  const loaded = entry.loaded ? "loaded" : "not confirmed loaded";
  return `${entry.group} · ${entry.kind} · ${entry.tool} · ${entry.scope} · ${status} · ${loaded} · ${displayPath(entry.path, cwd)}`;
}

function pickerRows(entries: ConfigEntry[], filter: string, cwd: string): PickerRow[] {
  const inventory: PickerRow = { kind: "inventory", title: "Current loaded Pi inventory", subtitle: "Active tools, extension/prompt/skill commands, model, cwd, and session" };
  const entryRows = entries
    .filter((entry) => !filter || matchesFilter(entry, filter, cwd))
    .map((entry): PickerRow => ({ kind: "entry", entry }));
  if (!filter || [inventory.title, inventory.subtitle].join(" ").toLowerCase().includes(filter.toLowerCase())) {
    return [inventory, ...entryRows];
  }
  return entryRows;
}

function previewLines(row: PickerRow, cwd: string): string[] {
  if (row.kind === "inventory") {
    return [
      "Shows the live Pi session surfaces that this extension can see.",
      "",
      "Includes:",
      "• active model and cwd",
      "• currently registered tools",
      "• slash commands from extensions, prompts, and skills",
      "",
      "Enter opens a read-only markdown inventory.",
    ];
  }

  const entry = row.entry;
  const exists = fileExists(entry.path);
  const stat = exists ? statSync(entry.path) : undefined;
  const supportsSettings = settingCatalogForEntry(entry).length > 0 && (entry.format === "json" || entry.format === "toml");
  const supportsEnv = supportsEnvInsertion(entry) && envCatalogFor(entry.tool).length > 0;
  return [
    entry.title,
    "",
    `Group: ${entry.group}`,
    `Surface: ${entry.tool}`,
    `Kind: ${entry.kind}`,
    `Scope: ${entry.scope}`,
    `Format: ${entry.format}`,
    `Status: ${exists ? "exists" : "missing"}${entry.loaded ? " · loaded/current" : ""}`,
    stat ? `Size: ${stat.size.toLocaleString()} bytes` : undefined,
    `Path: ${entry.path}`,
    entry.note ? `Note: ${entry.note}` : undefined,
    "",
    "Enter opens actions:",
    "• edit/view full file",
    supportsSettings ? "• add setting from reference" : undefined,
    supportsEnv ? "• add environment variable from reference" : undefined,
  ].filter((line): line is string => line !== undefined);
}

class PiConfigPicker implements Component {
  private selectedIndex = 0;
  private filter: string;

  constructor(
    private readonly entries: ConfigEntry[],
    initialFilter: string,
    private readonly cwd: string,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (result: PickerResult) => void,
  ) {
    this.filter = initialFilter;
    this.clampSelection();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      const row = this.rows()[this.selectedIndex];
      if (!row) return;
      this.done(row.kind === "inventory" ? { action: "inventory" } : { action: "entry", entry: row.entry });
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("k"))) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("j"))) {
      this.selectedIndex = Math.min(this.rows().length - 1, this.selectedIndex + 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 8);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.selectedIndex = Math.min(this.rows().length - 1, this.selectedIndex + 8);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      this.filter = [...this.filter].slice(0, -1).join("");
      this.clampSelection(true);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.filter = "";
      this.clampSelection(true);
      this.requestRender();
      return;
    }

    const printable = decodeKittyPrintable(data) ?? (/^[^\x00-\x1f\x7f]$/.test(data) ? data : undefined);
    if (printable) {
      this.filter += printable;
      this.clampSelection(true);
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(44, width);
    const color = (s: string) => this.theme.fg("accent", s);
    const rows = this.rows();
    this.clampSelection();
    const selected = rows[this.selectedIndex];
    const lines: string[] = [];
    lines.push(borderLine(safeWidth, "╭", "─", "╮", color, " pi-config "));
    const filterText = this.filter ? this.theme.fg("text", this.filter) : this.theme.fg("dim", "type to filter");
    lines.push(boxedLine(` Search: ${filterText}`, safeWidth, color));
    lines.push(boxedLine(this.theme.fg("dim", " ↑↓/ctrl+jk navigate · type filters · ctrl+u clear · enter open · esc close"), safeWidth, color));
    lines.push(borderLine(safeWidth, "├", "─", "┤", color));

    if (rows.length === 0) {
      lines.push(boxedLine(this.theme.fg("warning", ` No matches for ${JSON.stringify(this.filter)}`), safeWidth, color));
      lines.push(borderLine(safeWidth, "╰", "─", "╯", color));
      return lines;
    }

    if (safeWidth >= 96) this.renderSplit(lines, rows, selected, safeWidth, color);
    else this.renderStacked(lines, rows, selected, safeWidth, color);

    lines.push(borderLine(safeWidth, "╰", "─", "╯", color, `${this.selectedIndex + 1}/${rows.length}`));
    return lines;
  }

  private renderSplit(lines: string[], rows: PickerRow[], selected: PickerRow | undefined, width: number, color: (s: string) => string): void {
    const inner = width - 2;
    const leftWidth = Math.max(42, Math.floor(inner * 0.48));
    const rightWidth = inner - leftWidth - 1;
    const visibleRows = this.visibleRows(rows, 16);
    const preview = selected ? previewLines(selected, this.cwd) : [];
    const maxRows = Math.max(visibleRows.length, Math.min(16, preview.length));
    for (let i = 0; i < maxRows; i++) {
      const rowInfo = visibleRows[i];
      const left = rowInfo ? this.renderRow(rowInfo.row, rowInfo.index === this.selectedIndex, leftWidth) : "";
      const rightRaw = preview[i] ?? "";
      const right = i === 0 && rightRaw ? this.theme.fg("accent", this.theme.bold(rightRaw)) : rightRaw;
      lines.push(color("│") + fitLine(left, leftWidth) + color("│") + fitLine(this.theme.fg("muted", right), rightWidth) + color("│"));
    }
  }

  private renderStacked(lines: string[], rows: PickerRow[], selected: PickerRow | undefined, width: number, color: (s: string) => string): void {
    for (const rowInfo of this.visibleRows(rows, 10)) {
      lines.push(boxedLine(this.renderRow(rowInfo.row, rowInfo.index === this.selectedIndex, width - 2), width, color));
    }
    lines.push(borderLine(width, "├", "─", "┤", color));
    for (const line of (selected ? previewLines(selected, this.cwd) : []).slice(0, 8)) {
      lines.push(boxedLine(this.theme.fg("muted", line), width, color));
    }
  }

  private renderRow(row: PickerRow, selected: boolean, width: number): string {
    const marker = selected ? "→ " : "  ";
    const status = row.kind === "entry" ? (fileExists(row.entry.path) ? "●" : "○") : "◆";
    const title = `${marker}${status} ${rowTitle(row)}`;
    const subtitle = rowSubtitle(row, this.cwd);
    const plain = `${title} — ${subtitle}`;
    return selected ? this.theme.fg("accent", truncateToWidth(plain, width)) : truncateToWidth(plain, width);
  }

  private rows(): PickerRow[] {
    return pickerRows(this.entries, this.filter.trim(), this.cwd);
  }

  private visibleRows(rows: PickerRow[], maxRows: number): Array<{ row: PickerRow; index: number }> {
    const total = rows.length;
    const windowSize = Math.min(maxRows, total);
    const half = Math.floor(windowSize / 2);
    let start = Math.max(0, this.selectedIndex - half);
    start = Math.min(start, Math.max(0, total - windowSize));
    return rows.slice(start, start + windowSize).map((row, offset) => ({ row, index: start + offset }));
  }

  private clampSelection(reset = false): void {
    const count = this.rows().length;
    if (reset) this.selectedIndex = 0;
    if (count === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, count - 1));
  }
}

async function chooseEntryOverlay(ctx: ExtensionCommandContext, entries: ConfigEntry[], filter: string): Promise<PickerResult> {
  return ctx.ui.custom<PickerResult>((tui, theme, _keybindings, done) => new PiConfigPicker(entries, filter, ctx.cwd, theme, () => tui.requestRender(), done), {
    overlay: true,
    overlayOptions: {
      width: "88%",
      minWidth: 56,
      maxHeight: "85%",
      anchor: "center",
      margin: 1,
    },
  });
}

async function chooseFrom<T>(ctx: ExtensionCommandContext, title: string, items: T[], render: (item: T, index: number) => string): Promise<T | undefined> {
  if (items.length === 0) return undefined;
  const choices = items.map((item, index) => `${String(index + 1).padStart(2, "0")}. ${render(item, index)}`);
  const selected = await ctx.ui.select(title, choices);
  if (!selected) return undefined;
  const index = Number(selected.slice(0, selected.indexOf("."))) - 1;
  return items[index];
}

function settingCatalogFor(tool: SurfaceTool): SettingField[] {
  if (tool === "pi") return PI_SETTINGS;
  if (tool === "claude") return CLAUDE_SETTINGS;
  if (tool === "codex") return CODEX_SETTINGS;
  if (tool === "mcp") return MCP_SETTINGS;
  return [];
}

function settingCatalogForEntry(entry: ConfigEntry): SettingField[] {
  if (entry.kind === "mcp") return MCP_SETTINGS;
  if (entry.kind !== "settings") return [];
  return settingCatalogFor(entry.tool);
}

function envCatalogFor(tool: SurfaceTool): EnvVarField[] {
  return ENV_VARS.filter((entry) => entry.tools.includes(tool));
}

function supportsEnvInsertion(entry: ConfigEntry): boolean {
  return entry.kind === "settings" && ((entry.tool === "claude" && entry.format === "json") || (entry.tool === "codex" && entry.format === "toml"));
}

function currentKeysForJson(text: string): Set<string> {
  try {
    const parsed = JSON.parse(text || "{}");
    const keys = new Set<string>();
    const visit = (value: unknown, prefix: string) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const next = prefix ? `${prefix}.${key}` : key;
        keys.add(next);
        visit(child, next);
      }
    };
    visit(parsed, "");
    return keys;
  } catch {
    return new Set();
  }
}

function currentKeysForToml(text: string): Set<string> {
  const keys = new Set<string>();
  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      keys.add(section);
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (keyMatch) {
      const key = keyMatch[1];
      keys.add(key);
      if (section) keys.add(`${section}.${key}`);
    }
  }
  return keys;
}

function currentKeys(entry: ConfigEntry, text: string): Set<string> {
  if (entry.format === "json") return currentKeysForJson(text);
  if (entry.format === "toml") return currentKeysForToml(text);
  return new Set();
}

function jsonSetDotted(obj: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const parts = dottedKey.split(".").filter(Boolean);
  let target: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const existing = target[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      target[part] = {};
    }
    target = target[part] as Record<string, unknown>;
  }
  target[parts[parts.length - 1] ?? dottedKey] = value;
}

function insertJsonSetting(text: string, key: string, value: unknown): string | null {
  try {
    const parsed = text.trim() ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    jsonSetDotted(parsed as Record<string, unknown>, key, value);
    return JSON.stringify(parsed, null, 2) + "\n";
  } catch {
    return null;
  }
}

function tomlValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") return "{}";
  return JSON.stringify(String(value ?? ""));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceTomlAssignment(text: string, key: string, value: unknown): string | null {
  const pattern = new RegExp(`^(\\s*)${escapeRegex(key)}(\\s*=).*$`);
  const lines = text.split("\n");
  const replacement = `${key} = ${tomlValue(value)}`;
  for (let i = 0; i < lines.length; i++) {
    if (!pattern.test(lines[i])) continue;
    lines[i] = lines[i].replace(pattern, `$1${replacement}`);
    return ensureTrailingNewline(lines.join("\n"));
  }
  return null;
}

function insertTomlSetting(text: string, field: SettingField, overwrite = false): string | null {
  const key = field.key;
  const exists = currentKeysForToml(text).has(key);
  if (exists) {
    return overwrite ? replaceTomlAssignment(text, key, field.defaultValue) : null;
  }
  const prefix = text.trimEnd();
  const description = field.description ? `# ${field.description}\n` : "";
  return `${prefix}${prefix ? "\n\n" : ""}${description}${key} = ${tomlValue(field.defaultValue)}\n`;
}

function insertEnvVar(text: string, entry: ConfigEntry, envVar: EnvVarField, value: string): string | null {
  if (entry.format === "json") {
    const key = entry.tool === "mcp" ? `env.${envVar.name}` : `env.${envVar.name}`;
    return insertJsonSetting(text, key, value);
  }
  if (entry.format === "toml") {
    return insertTomlEnv(text, envVar.name, value);
  }
  return null;
}

function insertTomlEnv(text: string, name: string, value: string): string {
  const section = "shell_environment_policy.set";
  const lines = text.split("\n");
  const header = `[${section}]`;
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  const assignment = `${name} = ${tomlValue(value)}`;
  if (headerIndex < 0) {
    const prefix = text.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${header}\n${assignment}\n`;
  }
  let insertAt = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+]\s*$/.test(lines[i])) {
      insertAt = i;
      break;
    }
    if (new RegExp(`^\\s*${escapeRegex(name)}\\s*=`).test(lines[i])) {
      lines[i] = assignment;
      return ensureTrailingNewline(lines.join("\n"));
    }
  }
  lines.splice(insertAt, 0, assignment);
  return ensureTrailingNewline(lines.join("\n"));
}

async function editEntry(ctx: ExtensionCommandContext, entry: ConfigEntry): Promise<boolean> {
  const exists = fileExists(entry.path);
  if (!exists) {
    const create = await ctx.ui.confirm("Create file?", `${entry.title}\n\n${entry.path}\n\nThis file does not exist. Create it now?`);
    if (!create) return false;
  }
  const before = exists ? readText(entry.path) : (entry.createTemplate?.() ?? "");
  const edited = await ctx.ui.editor(entry.title, before);
  if (edited === undefined) return false;
  if (edited === before && exists) {
    ctx.ui.notify("No changes", "info");
    return false;
  }
  writeTextAtomic(entry.path, ensureTrailingNewline(edited));
  ctx.ui.notify(`Saved ${displayPath(entry.path, ctx.cwd)}`, "info");
  return true;
}

async function addSettingFromReference(ctx: ExtensionCommandContext, entry: ConfigEntry): Promise<boolean> {
  const catalog = settingCatalogForEntry(entry);
  if (catalog.length === 0 || (entry.format !== "json" && entry.format !== "toml")) {
    ctx.ui.notify("No setting reference is available for this file type", "warning");
    return false;
  }
  const filter = (await ctx.ui.input("Filter available settings", "model, compaction, mcp, shell..."))?.trim() ?? "";
  const before = fileExists(entry.path) ? readText(entry.path) : (entry.createTemplate?.() ?? "");
  const keys = currentKeys(entry, before);
  const filtered = filterCatalog(catalog, filter);
  const selected = await chooseFrom(ctx, "Add setting", filtered, (item) => {
    const present = keys.has(item.key) ? "✓ " : "";
    const choices = item.choices?.length ? ` (${item.choices.join(" | ")})` : "";
    return `${present}${item.key} · ${item.type}${choices} · ${item.description}`;
  });
  if (!selected) return false;
  let overwrite = false;
  if (keys.has(selected.key)) {
    overwrite = await ctx.ui.confirm("Setting already exists", `${selected.key} is already present. Replace it with the reference default?`);
    if (!overwrite) return false;
  }
  const after = entry.format === "json"
    ? insertJsonSetting(before, selected.key, selected.defaultValue)
    : insertTomlSetting(before, selected, overwrite);
  if (after === null) {
    ctx.ui.notify("Could not insert automatically. Open the file and edit manually.", "error");
    return false;
  }
  const reviewed = await ctx.ui.editor(`Review ${selected.key}`, after);
  if (reviewed === undefined) return false;
  writeTextAtomic(entry.path, ensureTrailingNewline(reviewed));
  ctx.ui.notify(`Saved ${displayPath(entry.path, ctx.cwd)}`, "info");
  return true;
}

async function addEnvFromReference(ctx: ExtensionCommandContext, entry: ConfigEntry): Promise<boolean> {
  if (entry.format !== "json" && entry.format !== "toml") {
    ctx.ui.notify("Environment variables can only be inserted into JSON/TOML settings files", "warning");
    return false;
  }
  const filter = (await ctx.ui.input("Filter environment variables", "OPENAI, GITHUB, PI_..."))?.trim() ?? "";
  const filtered = filterEnvCatalog(envCatalogFor(entry.tool), filter);
  const selected = await chooseFrom(ctx, "Add environment variable", filtered, (item) => `${item.name} · ${item.description}`);
  if (!selected) return false;
  const value = await ctx.ui.input(`Value for ${selected.name}`, selected.valueHint ?? "leave blank to insert an empty string");
  if (value === undefined) return false;
  const before = fileExists(entry.path) ? readText(entry.path) : (entry.createTemplate?.() ?? "");
  const after = insertEnvVar(before, entry, selected, value);
  if (after === null) {
    ctx.ui.notify("Could not insert environment variable automatically", "error");
    return false;
  }
  const reviewed = await ctx.ui.editor(`Review ${selected.name}`, after);
  if (reviewed === undefined) return false;
  writeTextAtomic(entry.path, ensureTrailingNewline(reviewed));
  ctx.ui.notify(`Saved ${displayPath(entry.path, ctx.cwd)}`, "info");
  return true;
}

function filterCatalog(catalog: SettingField[], filter: string): SettingField[] {
  const tokens = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = tokens.length === 0 ? catalog : catalog.filter((field) => {
    const haystack = [field.key, field.label, field.type, field.description, ...(field.choices ?? [])].join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
  return filtered.slice(0, 80);
}

function filterEnvCatalog(catalog: EnvVarField[], filter: string): EnvVarField[] {
  const tokens = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = tokens.length === 0 ? catalog : catalog.filter((field) => {
    const haystack = [field.name, field.description, ...(field.tools ?? [])].join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
  return filtered.slice(0, 80);
}

async function handleEntry(ctx: ExtensionCommandContext, entry: ConfigEntry): Promise<boolean> {
  while (true) {
    const supportsSettings = settingCatalogForEntry(entry).length > 0 && (entry.format === "json" || entry.format === "toml");
    const supportsEnv = supportsEnvInsertion(entry) && envCatalogFor(entry.tool).length > 0;
    const actions = [
      "Edit/view full file",
      ...(supportsSettings ? ["Add setting from reference"] : []),
      ...(supportsEnv ? ["Add environment variable from reference"] : []),
      "Show path and status",
      "Back",
    ];
    const selected = await ctx.ui.select(entry.title, actions);
    if (!selected || selected === "Back") return false;
    if (selected === "Edit/view full file") return editEntry(ctx, entry);
    if (selected === "Add setting from reference") return addSettingFromReference(ctx, entry);
    if (selected === "Add environment variable from reference") return addEnvFromReference(ctx, entry);
    if (selected === "Show path and status") {
      const details = [
        `Title: ${entry.title}`,
        `Group: ${entry.group}`,
        `Kind: ${entry.kind}`,
        `Tool/surface: ${entry.tool}`,
        `Scope: ${entry.scope}`,
        `Format: ${entry.format}`,
        `Loaded/current-session evidence: ${entry.loaded ? "yes" : "not directly confirmed"}`,
        `Exists: ${fileExists(entry.path) ? "yes" : "no"}`,
        `Path: ${entry.path}`,
        entry.note ? `Note: ${entry.note}` : undefined,
      ].filter(Boolean).join("\n");
      await ctx.ui.editor(`Details: ${entry.title}`, details);
    }
  }
}

function inventoryMarkdown(pi: ExtensionAPI, ctx: ExtensionCommandContext): string {
  const tools = pi.getAllTools().map((tool) => `- ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`).join("\n");
  const commands = pi.getCommands().map((command) => {
    const info = command.sourceInfo;
    return `- /${command.name} [${command.source}]${command.description ? ` — ${command.description}` : ""}${info?.path ? `\n  - ${displayPath(info.path, ctx.cwd)}` : ""}`;
  }).join("\n");
  const prompt = ctx.getSystemPrompt();
  return [
    "# Current Pi inventory",
    "",
    `cwd: ${ctx.cwd}`,
    `session: ${ctx.sessionManager.getSessionFile?.() ?? "unknown"}`,
    `model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"}`,
    `system prompt chars: ${prompt.length.toLocaleString()}`,
    "",
    "## Active tools",
    tools || "(none)",
    "",
    "## Slash commands (extension/prompt/skill)",
    commands || "(none)",
  ].join("\n");
}

async function maybeReload(ctx: ExtensionCommandContext): Promise<void> {
  const reload = await ctx.ui.confirm("Reload Pi resources?", "Saved. Run Pi's resource reload now? This reloads extensions, skills, prompts, themes, and context files. Some settings still require a new session or restart.");
  if (!reload) return;
  await ctx.reload();
  ctx.ui.notify("Pi resources reloaded", "info");
}

async function runNavigator(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }
  const initialFilter = args.trim();
  while (true) {
    const result = await chooseEntryOverlay(ctx, discoverEntries(pi, ctx), initialFilter);
    if (!result) return;
    if (result.action === "inventory") {
      await ctx.ui.editor("Current Pi inventory", inventoryMarkdown(pi, ctx));
      continue;
    }
    const changed = await handleEntry(ctx, result.entry);
    if (changed) await maybeReload(ctx);
  }
}

export default function piConfig(pi: ExtensionAPI) {
  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    try {
      await runNavigator(pi, ctx, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`${EXTENSION_NAME}: ${message}`, "error");
    }
  };

  pi.registerCommand("pi-config", {
    description: "Open Pi-native config navigator for settings, context files, skills, MCPs, and agents",
    handler,
  });

  pi.registerCommand("pcfg", {
    description: "Alias for /pi-config",
    handler,
  });
}
