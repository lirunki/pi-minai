export class MinaiPiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MinaiPiError";
  }
}

export class ContractValidationError extends MinaiPiError {
  constructor(message: string) {
    super(message, "contract_validation");
    this.name = "ContractValidationError";
  }
}

export class ServiceUnavailableError extends MinaiPiError {
  constructor(service: string) {
    super(`Required service is unavailable: ${service}`, "service_unavailable");
    this.name = "ServiceUnavailableError";
  }
}

export class SystemOneError extends MinaiPiError {
  constructor(message: string, code: "jev_http" | "jev_timeout" | "jev_transport" | "jev_backend", options?: { cause?: unknown }) {
    super(message, code, options);
    this.name = "SystemOneError";
  }
}
