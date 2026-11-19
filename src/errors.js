export class WfaError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "WfaError";
    this.code = code;
    this.details = options.details ?? null;
  }
}

export function assert(condition, code, message) {
  if (!condition) throw new WfaError(code, message);
}
