/**
 * Keyboard hand-off between RTTY panels, like `rttyFocus`: the QSO log card
 * registers its log action and the keyboard flow (mounted with the macro
 * panel, which owns the message slots) registers the ESM step, so shortcuts
 * work wherever keyboard focus is.
 */
type LogAction = () => Promise<boolean>;
type EsmStep = () => void;

let logAction: LogAction | null = null;
let esmStep: EsmStep | null = null;

/** Registers the QSO log card's "log this QSO" action; returns an unregister callback. */
export function registerRttyQsoLogger(action: LogAction): () => void {
  logAction = action;
  return () => {
    if (logAction === action) logAction = null;
  };
}

/** Logs the QSO in the RTTY log card. Resolves to false when nothing was logged. */
export function logRttyQso(): Promise<boolean> {
  return logAction ? logAction() : Promise.resolve(false);
}

/** Registers the Enter-sends-message (ESM) step; returns an unregister callback. */
export function registerRttyEsmStep(step: EsmStep): () => void {
  esmStep = step;
  return () => {
    if (esmStep === step) esmStep = null;
  };
}

/** Runs the next ESM step. Returns whether a step handler is mounted. */
export function runRttyEsmStep(): boolean {
  if (!esmStep) return false;
  esmStep();
  return true;
}

type CallsignFocus = () => boolean;
let callsignFocus: CallsignFocus | null = null;

/** Registers the log card's "focus the callsign field" action; returns an unregister callback. */
export function registerRttyCallsignFocus(focus: CallsignFocus): () => void {
  callsignFocus = focus;
  return () => {
    if (callsignFocus === focus) callsignFocus = null;
  };
}

/** Focuses the QSO callsign field when it is visible and not editing a logged QSO. */
export function focusRttyCallsign(): boolean {
  return callsignFocus ? callsignFocus() : false;
}
