export class CaddieError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly code = 'caddie_error',
  ) {
    super(message);
    this.name = 'CaddieError';
  }
}

export class UpstreamError extends CaddieError {
  constructor(message: string, readonly detail?: unknown) {
    super(message, 502, 'upstream_error');
    this.name = 'UpstreamError';
  }
}
