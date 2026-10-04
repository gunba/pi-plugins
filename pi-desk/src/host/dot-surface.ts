import { randomUUID } from "node:crypto";
import { DotBrowser } from "./dot-browser.ts";
import type { DotSurfaceFrame, DotSurfaceInput, DotSurfaceMode } from "../shared/dot.ts";

const SURFACE_STYLE = String.raw`(() => {
  let room;
  for (const element of document.querySelectorAll('[data-message-id], button[aria-label]')) {
    let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
    for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props?.services || !props.room?.aeon_id || !('header' in props)) continue;
      const stack = [fiber.child];
      while (stack.length) {
        const child = stack.pop(); if (!child) continue;
        if (child.stateNode instanceof HTMLElement) { room = child.stateNode; break; }
        if (child.sibling) stack.push(child.sibling); if (child.child) stack.push(child.child);
      }
      if (room) break;
    }
    if (room) break;
  }
  if (!room) throw Error('The native Dot view is unavailable.');
  room.setAttribute('data-pi-dot-surface', '');
  let style = document.getElementById('pi-dot-surface-style');
  if (!style) { style = document.createElement('style'); style.id = 'pi-dot-surface-style'; document.head.append(style); }
  style.textContent = '[data-pi-dot-surface]{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;z-index:50!important;background:var(--bg-primary,#fff)} [role=dialog]{position:fixed!important;inset:8px!important;width:calc(100vw - 16px)!important;max-width:none!important;max-height:calc(100vh - 16px)!important;overflow:auto!important;transform:none!important} [data-pi-dot-transform]{transform:none!important}';
})()`;
const SURFACE_RESET = "document.getElementById('pi-dot-surface-style')?.remove(); document.querySelector('[data-pi-dot-surface]')?.removeAttribute('data-pi-dot-surface'); document.querySelectorAll('[data-pi-dot-transform]').forEach(node => node.removeAttribute('data-pi-dot-transform'))";

/** A bounded pixel/input interface, never an arbitrary DevTools tunnel. */
export class DotSurface {
	readonly id = randomUUID();
	private browser: DotBrowser;
	private owned: boolean;
	private frame: DotSurfaceFrame;
	private unlisten?: () => void;
	private chooser?: number;
	private last = 0;
	private closed = false;
	private working: Promise<void> = Promise.resolve();
	private pending = 0;
	get busy(): boolean { return this.pending > 0; }
	private seen = new Set<string>();
	private held?: "left" | "right";
	private point = { x: 0, y: 0 };
	private scale = { x: 1, y: 1 };
	private capture = false;
	private captureJob: Promise<void> = Promise.resolve();
	private idle?: ReturnType<typeof setTimeout>;
	constructor(browser: DotBrowser, owned: boolean, dot: string, mode: DotSurfaceMode) {
		this.browser = browser; this.owned = owned;
		this.frame = { id: this.id, dot, mode, sequence: 0, width: 1024, height: 800 };
	}
	async open(): Promise<void> {
		await this.browser.call("Emulation.setDeviceMetricsOverride", { width: this.frame.width, height: this.frame.height, deviceScaleFactor: 1, mobile: false });
		await this.browser.call("Emulation.setFocusEmulationEnabled", { enabled: true });
		await new Promise(resolve => setTimeout(resolve, 250));
		await this.browser.evaluate(SURFACE_STYLE);
		if (this.frame.mode !== "conversation") {
			await this.browser.evaluate(`(() => {
				const buttons = [...document.querySelectorAll('button[aria-label]')];
				if (buttons.some(node => /^Close .+[’']s profile$/.test(node.getAttribute('aria-label')))) return;
				const button = buttons.find(node => /^Open .+[’']s profile$/.test(node.getAttribute('aria-label')));
				if (!button) throw Error('The native Dot profile is unavailable.'); button.click();
			})()`);
			await new Promise(resolve => setTimeout(resolve, 250));
			if (this.frame.mode === "computer") await this.browser.evaluate(`(() => {
				const button = [...document.querySelectorAll('[role=dialog] button')].find(node => /^Computer(?:\\s|$)/.test(node.textContent.trim()));
				if (button && button.getAttribute('aria-expanded') === 'false') button.click();
			})()`);
		}
		await this.browser.evaluate(`(() => {
			for (const dialog of document.querySelectorAll('[role=dialog]')) {
				for (let node = dialog.parentElement; node && node !== document.body; node = node.parentElement)
					if (getComputedStyle(node).transform !== 'none') node.setAttribute('data-pi-dot-transform', '');
			}
		})()`);
		const metrics = await this.browser.call("Page.getLayoutMetrics");
		this.scale = { x: metrics.cssVisualViewport.clientWidth / this.frame.width, y: metrics.cssVisualViewport.clientHeight / this.frame.height };
		this.unlisten = this.browser.onEvent(event => {
			if (event.method === "Page.frameNavigated" && !event.params.frame.parentId) {
				this.frame = { ...this.frame, image: undefined, fileChooser: undefined, error: "The native page changed. Return to the conversation and reopen this view." };
				this.chooser = undefined; void this.captureState(false).catch(() => {});
			}
			if (event.method === "closed") this.frame.error = "The native browser view closed. Open it again to continue.";
			if (event.method === "Page.fileChooserOpened") {
				this.chooser = event.params.backendNodeId;
				this.frame.fileChooser = { multiple: event.params.mode === "selectMultiple", accept: "" };
			}
			if (event.method !== "Page.screencastFrame") return;
			void this.browser.call("Page.screencastFrameAck", { sessionId: event.params.sessionId }).catch(() => {});
			if (this.frame.error) return;
			if (Date.now() - this.last < 200) return;
			this.last = Date.now();
			this.frame = { ...this.frame, sequence: this.frame.sequence + 1, image: event.params.data };
		});
		await this.browser.call("Page.setInterceptFileChooserDialog", { enabled: true });
		await this.keepAlive();
	}
	private captureState(active: boolean): Promise<void> {
		const job = this.captureJob.catch(() => {}).then(async () => {
			if (this.capture === active || active && this.closed) return;
			if (active) await this.browser.call("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: this.frame.width, maxHeight: this.frame.height, everyNthFrame: 6 });
			else await this.browser.call("Page.stopScreencast");
			this.capture = active;
		});
		this.captureJob = job; return job;
	}
	private async keepAlive(): Promise<void> {
		clearTimeout(this.idle);
		try { await this.browser.validateDot(this.frame.dot); }
		catch (error) {
			this.frame = { ...this.frame, image: undefined, fileChooser: undefined, error: error instanceof Error ? error.message : String(error) };
			this.chooser = undefined; await this.captureState(false).catch(() => {}); return;
		}
		await this.captureState(true);
		this.idle = setTimeout(() => { void this.captureState(false).catch(() => {}); }, 15_000);
		this.idle.unref();
	}
	async view(after?: number): Promise<DotSurfaceFrame> {
		if (this.closed) throw Error("Native Dot view is closed.");
		if (this.frame.error) return { ...this.frame, image: undefined, downloads: [] };
		await this.keepAlive();
		if (this.frame.error) return { ...this.frame, image: undefined, downloads: [] };
		return { ...this.frame, downloads: await this.browser.downloads(), ...(after === this.frame.sequence ? { image: undefined } : {}) };
	}
	async downloadChunk(id: string, offset: number): Promise<{ data: string; next: number; size: number }> {
		return this.browser.downloadChunk(id, offset);
	}
	async releaseDownload(id: string): Promise<void> { await this.browser.releaseDownload(id); }
	input(id: string, width: number, height: number, input: DotSurfaceInput): Promise<void> {
		if (this.closed || !this.frame.image || width !== this.frame.width || height !== this.frame.height) throw Error("The native view changed. Wait for its current frame.");
		if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid native input ID.");
		if (this.seen.has(id)) return Promise.resolve();
		this.seen.add(id); if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
		this.pending++;
		const job = this.working.catch(() => {}).then(async () => {
			if (this.closed || this.frame.error) throw Error("Native Dot view is closed or changed.");
			await this.browser.validateDot(this.frame.dot);
			if (input.kind === "click" || input.kind === "wheel" || input.kind === "pointer") {
				if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x >= width || input.y >= height) throw Error("Point is outside the native view.");
				this.point = { x: input.x * this.scale.x, y: input.y * this.scale.y };
				if (input.kind === "pointer") {
					if (!["left", "right"].includes(input.button) || !["down", "move", "up"].includes(input.phase) || ![1, 2].includes(input.count) || !Number.isInteger(input.modifiers) || input.modifiers < 0 || input.modifiers > 15) throw Error("Invalid pointer input.");
					if (input.phase === "down") this.held = input.button;
					await this.browser.call("Input.dispatchMouseEvent", { type: input.phase === "down" ? "mousePressed" : input.phase === "up" ? "mouseReleased" : "mouseMoved", ...this.point, button: this.held ?? "none", buttons: this.held === "left" ? 1 : this.held === "right" ? 2 : 0, modifiers: input.modifiers, clickCount: input.phase === "move" ? 0 : input.count });
					if (input.phase === "up") this.held = undefined;
				} else if (input.kind === "wheel") {
					if (!Number.isFinite(input.deltaX) || !Number.isFinite(input.deltaY) || Math.abs(input.deltaX) > 4000 || Math.abs(input.deltaY) > 4000) throw Error("Invalid scroll distance.");
					await this.browser.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...this.point, deltaX: input.deltaX * this.scale.x, deltaY: input.deltaY * this.scale.y });
				} else {
					if (!["left", "right"].includes(input.button) || ![1, 2].includes(input.count)) throw Error("Invalid click.");
					await this.browser.call("Input.dispatchMouseEvent", { type: "mousePressed", ...this.point, button: input.button, clickCount: input.count });
					await this.browser.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...this.point, button: input.button, clickCount: input.count });
				}
			} else if (input.kind === "text") {
				if (typeof input.text !== "string" || input.text.length > 32_000) throw Error("Native text is too long.");
				await this.browser.call("Input.insertText", { text: input.text });
			} else if (input.kind === "key") {
				if (typeof input.key !== "string" || input.key.length > 80 || typeof input.code !== "string" || input.code.length > 80 || !Number.isInteger(input.modifiers) || input.modifiers < 0 || input.modifiers > 15) throw Error("Invalid key input.");
				const keys: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Delete: 46, Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PageUp: 33, PageDown: 34 };
				const vk = keys[input.key] ?? (input.key.length === 1 ? input.key.toUpperCase().charCodeAt(0) : 0);
				const text = input.key.length === 1 && !(input.modifiers & 7) ? input.key : undefined;
				await this.browser.call("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...(text ? { text } : {}), key: input.key, code: input.code, modifiers: input.modifiers, windowsVirtualKeyCode: vk });
				await this.browser.call("Input.dispatchKeyEvent", { type: "keyUp", key: input.key, code: input.code, modifiers: input.modifiers, windowsVirtualKeyCode: vk });
			} else throw Error("Unsupported native input.");
		});
		const settled = job.finally(() => { this.pending--; });
		this.working = settled; return settled;
	}
	async chooseFiles(paths: string[]): Promise<void> {
		if (!this.chooser || this.closed) throw Error("The native file chooser changed. Open it again.");
		if (!this.frame.fileChooser?.multiple && paths.length !== 1) throw Error("This native picker accepts one file.");
		const node = this.chooser; this.chooser = undefined; this.frame.fileChooser = undefined;
		this.pending++;
		const job = this.working.catch(() => {}).then(async () => {
			if (this.closed || this.frame.error) throw Error("Native Dot view is closed or changed.");
			await this.browser.validateDot(this.frame.dot);
			await this.browser.call("DOM.setFileInputFiles", { files: paths, backendNodeId: node });
		}).finally(() => { this.pending--; });
		this.working = job; await job;
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true; clearTimeout(this.idle); await this.working.catch(() => {}); this.unlisten?.();
		if (this.held && !this.frame.error) await this.browser.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...this.point, button: this.held, clickCount: 1 }).catch(() => {});
		await this.captureState(false).catch(() => {});
		await this.browser.call("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
		await this.browser.evaluate(SURFACE_RESET).catch(() => {});
		await this.browser.call("Emulation.clearDeviceMetricsOverride").catch(() => {});
		await this.browser.call("Emulation.setFocusEmulationEnabled", { enabled: !this.owned }).catch(() => {});
		if (this.owned) await this.browser.close();
		this.frame.image = undefined;
	}
}
