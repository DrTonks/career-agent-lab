import { config as applicationConfig } from "../src/config.js";
/** Old protocol/fault fixtures explicitly omit semantic-review calls.
 * Dedicated final-review tests use application config with review enabled. */
export function config() {
  return { ...applicationConfig(), finalReview: "off" as const };
}
