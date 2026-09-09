import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

type ExecutionDeadline = { deadlineAt: number; signal: AbortSignal };
const deadlines = new AsyncLocalStorage<ExecutionDeadline>();

/** Request-local cancellation. Every network adapter must consume this signal. */
export function executionAbortSignal(): AbortSignal | undefined {
  const scope = deadlines.getStore();
  scope?.signal.throwIfAborted();
  return scope?.signal;
}

export function executionTimeRemainingMs(): number {
  const scope = deadlines.getStore();
  return scope ? Math.max(0, scope.deadlineAt - Date.now()) : Infinity;
}

/**
 * Wait for the operation's real cancellation; never race a write against a
 * timer. Children can shorten, but cannot extend, the owning request budget.
 */
export async function withExecutionDeadline<T>(deadlineAt: number, operation: () => Promise<T>): Promise<T> {
  const parent = deadlines.getStore();
  const effectiveDeadline = Math.min(deadlineAt, parent?.deadlineAt ?? Infinity);
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Execution deadline reached", "TimeoutError"));
  const inheritAbort = () => controller.abort(parent?.signal.reason);
  parent?.signal.addEventListener("abort", inheritAbort, { once: true });
  const remaining = effectiveDeadline - Date.now();
  const timer = setTimeout(abort, Math.max(0, remaining));
  timer.unref?.();
  if (remaining <= 0) abort();
  if (parent?.signal.aborted) inheritAbort();
  try {
    controller.signal.throwIfAborted();
    return await deadlines.run({ deadlineAt: effectiveDeadline, signal: controller.signal }, operation);
  } finally {
    clearTimeout(timer);
    parent?.signal.removeEventListener("abort", inheritAbort);
  }
}

/** Reserve time for a worker's fenced completion/failure receipt. */
export function withExecutionReserve<T>(reserveMs: number, operation: () => Promise<T>): Promise<T> {
  const scope = deadlines.getStore();
  return scope ? withExecutionDeadline(scope.deadlineAt - reserveMs, operation) : operation();
}

/** DNS has no cancellation API, but it is read-only. Never open a socket after cancellation. */
export function awaitAbortableRead<T>(operation: Promise<T>, signal = executionAbortSignal()): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
