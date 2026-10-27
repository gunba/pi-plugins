import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

test('the host SDK loads every bundled extension and Codex Wire', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-plugins-loading-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.equal(manifest.pi.extensions.filter(path => path === './pi-codex-wire/extensions/index.ts').length, 1);
  assert.equal(manifest.pi.extensions.filter(path => path === './pi-local-links/extensions/local-links.ts').length, 1);
  for (const path of ['./pi-agents/index.ts', './pi-context-window/index.ts']) {
    assert.equal(manifest.pi.extensions.filter(entry => entry === path).length, 1);
  }
  const paths = manifest.pi.extensions
    .map(path => fileURLToPath(new URL(path, root)));
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: paths,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, paths.length);
  assert.ok(result.extensions.some(extension => extension.commands.has('codex-wire')));
  for (const name of ['agent_start', 'agent_send', 'agent_list', 'agent_stop', 'agent_move', 'watch'])
    assert.equal(result.extensions.filter(extension => extension.tools.has(name)).length, 1, name);
  assert.ok(result.extensions.every(extension => !extension.tools.has('subagent') && !extension.tools.has('subagent_fork') && !extension.tools.has('report')));
  for (const removed of ['spawn_agent', 'send_message', 'followup_task', 'interrupt_agent', 'list_agents', 'wait_agent', 'agent_create', 'agent_fork', 'agent_discover', 'agent_close', 'agent_profile', 'agent_delivery', 'agent_inbox', 'exec_command', 'write_stdin', 'view_image', 'image_gen'])
    assert.ok(result.extensions.every(extension => !extension.tools.has(removed)), removed);
  assert.ok(result.extensions.some(extension => extension.commands.has('context-window')));
  assert.equal(result.extensions.filter(extension => extension.commands.has('work')).length, 1);
  const links = result.extensions.find(extension => extension.path.replaceAll('\\', '/').endsWith('/pi-local-links/extensions/local-links.ts'));
  assert.equal(typeof links?.markdownTransformer, 'function');
});

test('the package exposes Image 2.5 through native image models without restoring image_gen', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-images-loading-'));
  let session;
  const env = { agent: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = directory; process.env.PI_OFFLINE = '1';
  t.after(async () => {
    try { await session?.dispose(); }
    finally {
      if (env.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = env.agent;
      if (env.offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = env.offline;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const credentials = new InMemoryCredentialStore();
  const jwt = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.x`;
  await credentials.modify('openai', async () => ({ type: 'api_key', key: 'fixture-key' }));
  await credentials.modify('openai-codex', async () => ({ type: 'oauth', access: jwt, refresh: 'fixture', expires: Date.now() + 3600000 }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
    modelsStorePath: join(directory, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
  const before = runtime.getModels('openai').map(model => model.id);
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: manifest.pi.extensions.filter(path => path.includes('/pi-openai-images/') || path === './pi-codex-wire/extensions/index.ts').map(path => fileURLToPath(new URL(path, root))) });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  loader.getExtensions().runtime.flagValues.set('codex-wire-version', '0.159.1');
  loader.getExtensions().runtime.flagValues.set('codex-wire-transport', 'sse');
  ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime,
    model: runtime.getModels('openai')[0], settingsManager: settings, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(directory), tools: [] }));
  const errors = [];
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  assert.deepEqual(errors, []);
  for (const provider of ['openai', 'openai-codex']) {
    const ids = runtime.getModelsOfType('image', provider).map(model => model.id);
    assert.ok(ids.includes('gpt-image-2.5-sunburst'), `${provider} must expose Sunburst`);
    assert.ok(ids.includes('gpt-image-2.5-flare'), `${provider} must expose Flare`);
    assert.equal(typeof runtime.getProvider(provider).generateImages, 'function');
  }
  assert.deepEqual(runtime.getModels('openai').map(model => model.id), before);
  assert.ok(loader.getExtensions().extensions.every(extension => !extension.tools.has('image_gen')));
  const generate = async provider => {
    const image = runtime.getModelOfType('image', provider, 'gpt-image-2.5-flare');
    const result = await runtime.generateImages(image, { input: [{ type: 'text', text: 'Native image fixture' }] }, { fetch: async (url, init) => {
      assert.equal(String(url), provider === 'openai' ? 'https://api.openai.com/v1/images/generations' : 'https://chatgpt.com/backend-api/codex/images/generations');
      assert.equal(JSON.parse(init.body).model, image.id);
      assert.equal(new Headers(init.headers).has('session_id'), false, 'image requests do not reuse the working conversation transport');
      return Response.json({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNYkKIBAALUAS0ACLPLAAAAAElFTkSuQmCC' }] });
    } });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.deepEqual(result.output, [{ type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNYkKIBAALUAS0ACLPLAAAAAElFTkSuQmCC', mimeType: 'image/png' }]);
  };
  await generate('openai'); await generate('openai-codex');
  await session.setModel(runtime.getModels('openai-codex')[0]);
  await generate('openai-codex');
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  await generate('openai-codex');
  assert.deepEqual(errors, []);
});
