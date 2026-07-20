export interface ProfileActivationResultLike {
  success?: unknown;
  engineRunning?: unknown;
  error?: unknown;
  message?: unknown;
}

export interface ProfileActivationAssessment {
  success: boolean;
  error?: string;
}

export function assessProfileActivation(
  result: ProfileActivationResultLike,
): ProfileActivationAssessment {
  const error = typeof result.error === 'string' && result.error.trim()
    ? result.error
    : typeof result.message === 'string' && result.message.trim()
      ? result.message
      : undefined;

  if (result.success !== true || result.engineRunning === false) {
    return { success: false, error };
  }

  return { success: true };
}
