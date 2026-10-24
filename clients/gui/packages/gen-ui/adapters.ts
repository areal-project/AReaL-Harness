export type Event<T> = (listener: (value: T) => void) => { dispose(): void };
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  event: Event<T> = listener => { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; };
  fire(value: T) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
export const createServiceLogger = (_name: string) => ({ warn: (_context: unknown, message: string, _details: unknown) => console.warn(message) });
