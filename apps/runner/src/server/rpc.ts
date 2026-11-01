import { chmodSync, existsSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, RpcRequest, type EventEnvelope, type RpcResponse } from '@wots/protocol';
import { redact } from '@wots/security';
import { lineReader } from '@wots/core';
import { RelayError } from '../sessions/controller.ts';

export type Handler = (params: unknown, conn: Connection) => unknown | Promise<unknown>;

export interface Connection {
  id: number;
  subscriptions: Set<string>;
  send(obj: unknown): void;
  // Set for remote (gateway) connections: the paired device and the methods it may call.
  deviceId?: string;
  allow?: ReadonlySet<string>;
}

type Attached = Connection & { close(): void };

const MAX_SUBSCRIPTIONS = 32;

// Newline-delimited JSON over a user-only Unix domain socket.
export class RpcServer {
  private server: Server | null = null;
  private readonly conns = new Set<Attached>();
  private nextConn = 1;
  private readonly handlers: Record<string, Handler>;

  constructor(handlers: Record<string, Handler>) {
    this.handlers = handlers;
  }

  listen(socketPath: string): Promise<void> {
    if (existsSync(socketPath)) rmSync(socketPath, { force: true }); // caller holds the daemon lock
    this.server = createServer((socket) => this.accept(socket));
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(socketPath, () => {
        chmodSync(socketPath, 0o600);
        resolve();
      });
    });
  }

  private accept(socket: Socket): void {
    const conn = {
      id: this.newConnectionId(),
      subscriptions: new Set<string>(),
      send: (obj: unknown) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify(obj)}\n`);
      },
      close: () => socket.destroy(),
    };
    this.conns.add(conn);
    let received = 0;
    socket.on(
      'data',
      lineReader((line) => {
        received = 0;
        void this.dispatch(line, conn);
      }, MAX_FRAME_BYTES),
    );
    socket.on('data', (c: Buffer) => {
      received += c.length;
      if (received > MAX_FRAME_BYTES * 2) socket.destroy();
    });
    socket.on('close', () => this.conns.delete(conn));
    socket.on('error', () => this.conns.delete(conn));
  }

  // Connections that arrive by another transport share the same handlers and broadcasts.
  newConnectionId(): number {
    return this.nextConn++;
  }

  attach(conn: Attached): () => void {
    this.conns.add(conn);
    return () => this.conns.delete(conn);
  }

  async dispatch(line: string, conn: Connection): Promise<void> {
    let id: string | number = 0;
    try {
      const req = RpcRequest.parse(JSON.parse(line));
      id = req.id;
      const h = conn.allow && !conn.allow.has(req.method) ? undefined : this.handlers[req.method];
      if (!h) throw new RelayError('unknown_method', `Unknown method ${req.method}`);
      const result = await h(req.params ?? {}, conn);
      conn.send({ v: PROTOCOL_VERSION, id, result } satisfies RpcResponse);
    } catch (e) {
      const code = e instanceof RelayError ? e.code : (e as { name?: string })?.name === 'ZodError' ? 'invalid_params' : 'internal';
      const message = redact(e instanceof Error ? e.message : String(e)).slice(0, 2000);
      conn.send({ v: PROTOCOL_VERSION, id, error: { code, message } } satisfies RpcResponse);
    }
  }

  subscribe(conn: Connection, sessionId: string): void {
    if (conn.subscriptions.size >= MAX_SUBSCRIPTIONS) throw new RelayError('too_many_subscriptions', 'Subscription limit reached');
    conn.subscriptions.add(sessionId);
  }

  broadcast(e: EventEnvelope): void {
    for (const c of this.conns) if (c.subscriptions.has(e.sessionId) || c.subscriptions.has('*')) c.send({ v: PROTOCOL_VERSION, method: 'event', params: e });
  }

  close(): Promise<void> {
    for (const c of this.conns) c.close();
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
