/** Evaluated only in Desk's task-owned, first-party ChatGPT tab. */
export const DOT_NATIVE = String.raw`(() => {
  function context() {
    const elements = [...document.querySelectorAll('[data-message-id]'),
      ...document.querySelectorAll('button[aria-label]')].filter(node =>
        node.hasAttribute('data-message-id') || /^Open .+[’']s profile$/.test(node.getAttribute('aria-label') || ''));
    for (const node of elements) {
      let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber'))];
      for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (props?.services?.conversations?.get && props.room?.aeon_id && props.room.id) return props;
      }
    }
    throw Error('The native Dot conversation is not ready. Open your Dot in ChatGPT, then reconnect.');
  }
  function snapshot() {
    const current = context(), room = current.room, state = current.services.conversations.get(room.id);
    if (state.error) throw Error(state.error);
    const messages = state.messages;
    if (!Array.isArray(messages)) throw Error('ChatGPT’s native messaging interface changed.');
    return { dot: room.aeon_id, room: room.id, name: room.name, path: location.pathname,
      messages: messages.filter(message => !message.deletedAt).map(message => ({
        id: message.id, senderAeonId: message.senderAeonId, senderName: message.senderName, self: message.self,
        text: message.text, createdAt: message.createdAt, requestId: message.requestId, deliveryState: message.deliveryState,
        attachments: message.attachments?.map(file => ({ attachmentId: file.attachmentId, fileId: file.fileId,
          type: file.type, name: file.name, title: file.title, mime: file.mime, sizeBytes: file.sizeBytes,
          status: file.status, hasContent: file.hasContent, hasPreview: file.hasPreview, contentType: file.contentType }))
      })), before: state.cursors?.before,
      uploads: current.services.composer.state.getSnapshot().uploads.filter(upload => upload.roomId === room.id).map(upload => ({
        id: upload.id, roomId: upload.roomId, name: upload.name, sizeBytes: upload.sizeBytes,
        status: upload.status, fileId: upload.fileId, progress: upload.progress, error: upload.error
      })),
      draft: current.services.composer.state.getSnapshot().drafts.get(room.id)?.text || '' };
  }
  function primary() {
    const link = [...document.querySelectorAll('a[href]')].find(node => node.origin === location.origin && /^\/dots\/[a-zA-Z0-9_~-]+$/.test(node.pathname));
    return link ? { name: link.textContent.trim(), path: link.pathname } : null;
  }
  async function older(cursor) {
    const current = context(), before = current.services.conversations.get(current.room.id).cursors?.before;
    if (cursor !== before) throw Error('Dot history changed. Refresh before loading earlier messages.');
    await current.services.conversations.older(current.room.id);
    return snapshot();
  }
  window.__piDeskDotNative = { context, snapshot, primary, older };
})()`;

export interface NativeDotAttachment {
  attachmentId: string; fileId?: string; name?: string; title?: string; mime?: string; sizeBytes?: number;
  type: string; status?: string; hasContent?: boolean; hasPreview?: boolean; contentType?: string;
}
export interface NativeDotMessage {
  id: string; senderAeonId?: string; senderName?: string; self?: boolean; text: string;
  createdAt: number | string; deletedAt?: number | null; requestId?: string; deliveryState?: string;
  attachments?: NativeDotAttachment[];
}
export interface NativeDotUpload {
  id: string; roomId: string; name: string; sizeBytes: number; status: string;
  fileId?: string; progress?: number; error?: string;
}
export interface NativeDotSnapshot {
  dot: string; room: string; name: string; path: string; messages: NativeDotMessage[];
  before?: string; uploads: NativeDotUpload[]; draft: string;
}
