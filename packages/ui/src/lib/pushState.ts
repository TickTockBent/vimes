// Push notification permission state machine (pure). The bell affordance in the
// session-list header renders one of four states; enabling is ALWAYS a deliberate
// tap (spec §3.8 — never auto-prompt), so this only DERIVES the display state from
// the environment. Transitions are exercised in pushState.test.ts.

export type PushUiState = 'unsupported' | 'denied' | 'off' | 'on';

// Browser permission values (Notification.permission).
export type NotificationPermissionValue = 'default' | 'granted' | 'denied';

export interface PushEnvironment {
  // Whether this browser supports the full push stack: Notification API, a
  // service-worker registration, and PushManager. Missing any → 'unsupported'
  // (e.g. a non-secure context, or iOS Safari outside an installed PWA).
  supported: boolean;
  // The current Notification permission.
  permission: NotificationPermissionValue;
  // Whether we currently hold an active push subscription (pushManager).
  subscribed: boolean;
}

// Precedence: unsupported > denied > on > off. 'denied' is a dead end the user
// must fix in browser settings; 'off' means we CAN enable (permission default, or
// granted-but-not-yet-subscribed) with a deliberate tap; 'on' means fully wired.
export function derivePushState(environment: PushEnvironment): PushUiState {
  if (!environment.supported) {
    return 'unsupported';
  }
  if (environment.permission === 'denied') {
    return 'denied';
  }
  if (environment.permission === 'granted' && environment.subscribed) {
    return 'on';
  }
  return 'off';
}

// The label shown on the bell for each state.
export function pushStateLabel(state: PushUiState): string {
  switch (state) {
    case 'unsupported':
      return 'Push unavailable';
    case 'denied':
      return 'Push blocked';
    case 'on':
      return 'Notifications on';
    case 'off':
      return 'Enable notifications';
    default:
      return 'Notifications';
  }
}

// Whether a tap on the bell should attempt to ENABLE (true) or DISABLE (false).
// Only meaningful in the 'off' / 'on' states; unsupported/denied are inert.
export function isEnableTap(state: PushUiState): boolean {
  return state === 'off';
}

export function isBellActionable(state: PushUiState): boolean {
  return state === 'off' || state === 'on';
}
