import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

const RECOVERABLE_OPTIONAL_ERROR_PATTERNS = [
  'not supported by this radio',
  'feature not available',
  'invalid parameter',
  'protocol error',
];

function collectErrorMessages(error: unknown, messages: string[] = []): string[] {
  if (error instanceof RadioError) {
    messages.push(error.message, error.userMessage);
    if (error.cause && error.cause !== error) {
      collectErrorMessages(error.cause, messages);
    }
    return messages;
  }

  if (error instanceof Error) {
    messages.push(error.message);
    return messages;
  }

  messages.push(String(error));
  return messages;
}

export function isRecoverableOptionalRadioError(error: unknown): boolean {
  if (
    error instanceof RadioError
    && error.code === RadioErrorCode.INVALID_OPERATION
    && error.severity === RadioErrorSeverity.WARNING
    && error.context?.recoverable === true
  ) {
    return true;
  }

  return collectErrorMessages(error).some((message) => {
    const lowerMessage = message.toLowerCase();
    return RECOVERABLE_OPTIONAL_ERROR_PATTERNS.some((pattern) => lowerMessage.includes(pattern));
  });
}
