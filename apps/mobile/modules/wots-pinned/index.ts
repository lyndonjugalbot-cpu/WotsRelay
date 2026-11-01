import { NativeModule, requireNativeModule } from 'expo';

type Events = {
  onSocketOpen(e: { id: string }): void;
  onSocketMessage(e: { id: string; data: string }): void;
  onSocketClose(e: { id: string; code: number; reason: string }): void;
};

declare class WotsPinnedModule extends NativeModule<Events> {
  request(url: string, method: string, body: string | null, fingerprint: string): Promise<{ status: number; body: string }>;
  connect(id: string, url: string, fingerprint: string): void;
  send(id: string, text: string): void;
  close(id: string, code: number): void;
}

// HTTPS and WebSocket that accept only the certificate whose SHA-256 matches `fingerprint`.
export default requireNativeModule<WotsPinnedModule>('WotsPinned');
