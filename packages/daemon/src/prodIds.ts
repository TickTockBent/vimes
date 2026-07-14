import { randomUUID } from 'node:crypto';
import type { Clock, IdSource } from '@vimes/core';

// determinism-exempt: production boundary (rule 0.3) — core never imports this.
// The deterministic core takes Clock/IdSource by injection; these are the real
// time and real UUID source the daemon wires in at composition.
export const productionClock: Clock = {
  now(): string {
    return new Date().toISOString();
  },
};

export const productionIdSource: IdSource = {
  uuid(): string {
    return randomUUID();
  },
};
