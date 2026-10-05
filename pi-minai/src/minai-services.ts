import { ServiceRegistry } from "./registry.js";

/** Shared in-process registry used by independently loaded Pi extensions. */
export const minaiServices = new ServiceRegistry();
