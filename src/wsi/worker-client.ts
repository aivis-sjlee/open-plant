export interface WorkerClientHandlers<Res extends { id: number }, Pending> {
  onResponse: (message: Res, pending: Pending) => void;
  rejectPending: (pending: Pending, error: Error) => void;
}

export class WorkerClient<Res extends { id: number }, Pending> {
  private worker: Worker | null = null;
  private supported = true;
  private requestId = 1;
  private readonly pendingById = new Map<number, Pending>();

  private readonly handleMessage = (event: MessageEvent<Res>): void => {
    const message = event.data;
    if (!message) return;
    const pending = this.pendingById.get(message.id);
    if (!pending) return;
    this.pendingById.delete(message.id);
    this.handlers.onResponse(message, pending);
  };

  private readonly handleError = (): void => {
    this.supported = false;
    this.teardownWorker("worker crashed");
  };

  constructor(
    private readonly createWorker: () => Worker,
    private readonly handlers: WorkerClientHandlers<Res, Pending>,
  ) {}

  beginRequest(pending: Pending): { id: number; worker: Worker } | null {
    const worker = this.getOrCreateWorker();
    if (!worker) return null;
    const id = this.requestId++;
    this.pendingById.set(id, pending);
    return { id, worker };
  }

  cancelRequest(id: number): Pending | undefined {
    const pending = this.pendingById.get(id);
    if (!pending) return undefined;
    this.pendingById.delete(id);
    return pending;
  }

  terminate(reason = "worker terminated"): void {
    this.teardownWorker(reason);
  }

  private getOrCreateWorker(): Worker | null {
    if (!this.supported) return null;
    if (this.worker) return this.worker;

    try {
      const worker = this.createWorker();
      worker.addEventListener("message", this.handleMessage);
      worker.addEventListener("error", this.handleError);
      this.worker = worker;
      return worker;
    } catch {
      this.supported = false;
      return null;
    }
  }

  private teardownWorker(reason: string): void {
    if (this.worker) {
      this.worker.removeEventListener("message", this.handleMessage);
      this.worker.removeEventListener("error", this.handleError);
      this.worker.terminate();
      this.worker = null;
    }

    const error = new Error(reason);
    for (const [, pending] of this.pendingById) {
      this.handlers.rejectPending(pending, error);
    }
    this.pendingById.clear();
  }
}
