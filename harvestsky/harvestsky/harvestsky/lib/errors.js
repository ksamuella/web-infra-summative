'use strict';

/** An error that maps directly to an HTTP response. */
class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

module.exports = { HttpError };
