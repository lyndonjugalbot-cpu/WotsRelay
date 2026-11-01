import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Narrow, validated bridge. The renderer never sees Node, the socket, or credentials.
const api = {
  call: async (method: string, params?: unknown): Promise<unknown> => {
    if (typeof method !== 'string' || method.length > 64) throw new Error('bad method');
    const res = (await ipcRenderer.invoke('wots:call', method, params ?? {})) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (!res.ok) throw Object.assign(new Error(res.error?.message ?? 'error'), { code: res.error?.code });
    return res.result;
  },
  onEvent: (fn: (e: unknown) => void) => {
    const h = (_: IpcRendererEvent, e: unknown) => fn(e);
    ipcRenderer.on('wots:event', h);
    return () => ipcRenderer.removeListener('wots:event', h);
  },
  onRunner: (fn: (s: { online: boolean; error?: string }) => void) => {
    const h = (_: IpcRendererEvent, s: { online: boolean; error?: string }) => fn(s);
    ipcRenderer.on('wots:runner', h);
    return () => ipcRenderer.removeListener('wots:runner', h);
  },
  pickProject: (): Promise<string | null> => ipcRenderer.invoke('wots:pickProject') as Promise<string | null>,
  reconnect: (): Promise<boolean> => ipcRenderer.invoke('wots:reconnect') as Promise<boolean>,
};

contextBridge.exposeInMainWorld('wots', api);
export type WotsBridge = typeof api;
