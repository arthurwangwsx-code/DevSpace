import { randomUUID } from "node:crypto";
import type { JsonObject } from "./types.js";

export interface CapabilityEvent {
  id: string;
  type: string;
  at: string;
  data: JsonObject;
}

export class CapabilityEventHub {
  private readonly listeners = new Set<(event: CapabilityEvent) => void>();
  private sequence = 0;

  publish(type: string, data: JsonObject): CapabilityEvent {
    const event = {
      id: `${++this.sequence}-${randomUUID()}`,
      type,
      at: new Date().toISOString(),
      data: structuredClone(data),
    };
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: (event: CapabilityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
