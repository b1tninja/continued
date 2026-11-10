import { limit as configured } from "./settings.js";

/** The number of requests the client may make at once. */
export function limit() {
  return configured;
}
