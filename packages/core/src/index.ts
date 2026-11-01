export * from './adapter.ts';
export * from './stateMachine.ts';
export * from './policy.ts';
export * from './process.ts';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
export * from './shellRisk.ts';
