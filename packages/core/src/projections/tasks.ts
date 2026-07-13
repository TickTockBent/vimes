import { canonicalJson } from '../canonicalJson.js';
import type { EventRecord, TaskRecord } from '../schemas.js';
import type { Projection } from './projection.js';

// STUB (slice 6 is the task system). The schema shape lands now; task events
// wait for their dispatcher, so `apply` folds nothing yet — it is a valid,
// deterministic, empty projection over the TaskRecord map.

export interface TasksState {
  tasks: Record<string, TaskRecord>;
}

export const tasksProjection: Projection<TasksState> = {
  id: 'tasks',

  init(): TasksState {
    return { tasks: {} };
  },

  apply(state: TasksState, _event: EventRecord): TasksState {
    return state;
  },

  serialize(state: TasksState): string {
    return canonicalJson(state);
  },
};
