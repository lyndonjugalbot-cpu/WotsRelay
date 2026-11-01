import WotsPinned from '../modules/wots-pinned/index.ts';
import type { Transport, TransportHandlers } from './relay/client.ts';

// Pinned HTTPS/WebSocket from the Swift module. One listener set routes events by socket id.
const handlers = new Map<string, TransportHandlers>();
WotsPinned.addListener('onSocketOpen', (e) => handlers.get(e.id)?.onOpen());
WotsPinned.addListener('onSocketMessage', (e) => handlers.get(e.id)?.onMessage(e.data));
WotsPinned.addListener('onSocketClose', (e) => {
  const h = handlers.get(e.id);
  handlers.delete(e.id);
  h?.onClose(e.code, e.reason);
});

let next = 1;

export const nativeTransport: Transport = {
  open(url, fingerprint, h) {
    const id = `s${next++}`;
    handlers.set(id, h);
    WotsPinned.connect(id, url, fingerprint);
    return { send: (text) => WotsPinned.send(id, text), close: (code) => WotsPinned.close(id, code) };
  },
  request(url, method, body, fingerprint) {
    return WotsPinned.request(url, method, body, fingerprint);
  },
};
