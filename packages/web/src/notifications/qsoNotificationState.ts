import type { NotificationPermissionState } from './notificationDriver';

export type QsoNotificationStatus = 'active' | 'disabled' | 'needs-permission' | 'blocked' | 'unsupported';

export interface QsoNotificationRuntimeState {
  supported: boolean;
  secureContext: boolean;
  permission: NotificationPermissionState;
  preferenceEnabled: boolean;
  status: QsoNotificationStatus;
  isBlocked: boolean;
  isEffectivelyEnabled: boolean;
  canRequestPermission: boolean;
}

interface ResolveQsoNotificationRuntimeStateInput {
  supported: boolean;
  secureContext: boolean;
  permission: NotificationPermissionState;
  preferenceEnabled: boolean;
}

export function resolveQsoNotificationRuntimeState({
  supported,
  secureContext,
  permission,
  preferenceEnabled,
}: ResolveQsoNotificationRuntimeStateInput): QsoNotificationRuntimeState {
  const unsupported = !supported || !secureContext || permission === 'unsupported';

  if (unsupported) {
    return {
      supported,
      secureContext,
      permission,
      preferenceEnabled,
      status: 'unsupported',
      isBlocked: false,
      isEffectivelyEnabled: false,
      canRequestPermission: false,
    };
  }

  if (preferenceEnabled && permission === 'denied') {
    return {
      supported,
      secureContext,
      permission,
      preferenceEnabled,
      status: 'blocked',
      isBlocked: true,
      isEffectivelyEnabled: false,
      canRequestPermission: false,
    };
  }

  if (preferenceEnabled && permission === 'default') {
    return {
      supported,
      secureContext,
      permission,
      preferenceEnabled,
      status: 'needs-permission',
      isBlocked: false,
      isEffectivelyEnabled: false,
      canRequestPermission: true,
    };
  }

  if (preferenceEnabled && permission === 'granted') {
    return {
      supported,
      secureContext,
      permission,
      preferenceEnabled,
      status: 'active',
      isBlocked: false,
      isEffectivelyEnabled: true,
      canRequestPermission: false,
    };
  }

  return {
    supported,
    secureContext,
    permission,
    preferenceEnabled,
    status: 'disabled',
    isBlocked: false,
    isEffectivelyEnabled: false,
    canRequestPermission: permission === 'default',
  };
}
