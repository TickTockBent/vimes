export interface Clock {
  now(): string;
}

export interface IdSource {
  uuid(): string;
}

export class SteppingClock implements Clock {
  private currentEpochMilliseconds: number;
  private readonly stepMilliseconds: number;

  constructor(epochIso: string, stepMilliseconds: number) {
    this.currentEpochMilliseconds = Date.parse(epochIso);
    this.stepMilliseconds = stepMilliseconds;
  }

  now(): string {
    const currentIso = new Date(this.currentEpochMilliseconds).toISOString();
    this.currentEpochMilliseconds += this.stepMilliseconds;
    return currentIso;
  }
}

export class CountingIdSource implements IdSource {
  private nextCounterValue = 1;

  uuid(): string {
    const paddedCounter = String(this.nextCounterValue).padStart(12, '0');
    this.nextCounterValue += 1;
    return `00000000-0000-4000-8000-${paddedCounter}`;
  }
}
