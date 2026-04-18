/**
 * Hamlib error codes used on the rigctld wire as `RPRT N`.
 *
 * Negative values follow the subset of `RIG_E*` constants that clients actually
 * inspect. See `include/hamlib/rig.h` in the Hamlib source tree for the canonical
 * list.
 */
export const RigErr = {
  OK: 0,
  EINVAL: -1,
  ECONF: -2,
  ENOMEM: -3,
  ENIMPL: -11,
  ETIMEOUT: -4,
  EIO: -5,
  EINTERNAL: -6,
  EPROTO: -7,
  ERJCTED: -8,
  ETRUNC: -9,
  ENAVAIL: -10,
  EVFO: -12,
  EDOM: -13,
} as const;

export type RigErrCode = (typeof RigErr)[keyof typeof RigErr];

export class RigctldProtocolError extends Error {
  constructor(
    public readonly code: RigErrCode,
    message?: string,
  ) {
    super(message ?? `rigctld error ${code}`);
    this.name = 'RigctldProtocolError';
  }
}
