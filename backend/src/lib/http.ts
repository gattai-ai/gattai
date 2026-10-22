import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Bentuk error seragam untuk seluruh API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
}

export function errorBody(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): ApiErrorBody {
  return { error: { code, message, ...extra } };
}

/** Error dengan status HTTP, ditangkap oleh error handler global. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly extra?: Record<string, unknown>;

  constructor(status: ContentfulStatusCode, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  toBody(): ApiErrorBody {
    return errorBody(this.code, this.message, this.extra);
  }
}
