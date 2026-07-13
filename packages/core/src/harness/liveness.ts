import { canTransition, INITIAL_LIVENESS } from '../sessionMachine.js';
import { livenessChanged, transitionRejected, type Liveness } from '../events.js';
import type { EventRecord } from '../schemas.js';
import type { World } from './world.js';

// Guarded liveness emission (rule 0.3: edges enforced at the emitter). Reads the
// session's current liveness from the live projection host and emits
// liveness_changed for a legal edge, transition_rejected otherwise. An emitter
// therefore never writes an illegal edge into the log; a scripted illegal attempt
// surfaces as transition_rejected.
export function emitGuardedLiveness(
  world: World,
  appSessionId: string,
  to: Liveness,
  cause: string,
): EventRecord[] {
  const currentSession = world.projectionHost.sessionsState().sessions[appSessionId];
  const from: Liveness = currentSession?.liveness ?? INITIAL_LIVENESS;
  if (canTransition(from, to)) {
    return world.router.emit([livenessChanged({ appSessionId, to, cause })]);
  }
  return world.router.emit([transitionRejected({ appSessionId, from, to, cause })]);
}
