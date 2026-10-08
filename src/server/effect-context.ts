import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<{ operationId?: string }>();

/** Operation id for the effect currently running, when the harness started one. */
export function effectOperationId() {
  return storage.getStore()?.operationId;
}

export function runWithOperation<T>(operationId: string, fn: () => T): T {
  return storage.run({ operationId }, fn);
}
