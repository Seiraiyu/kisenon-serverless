interface IntegrationEnvironment {
  DATABASE_URL?: string;
  REQUIRE_INTEGRATION?: string;
}

/** Fail before test discovery when a caller explicitly requires live coverage. */
export function requireDatabaseUrl(env: IntegrationEnvironment): void {
  if (env.REQUIRE_INTEGRATION === "1" && !env.DATABASE_URL?.trim()) {
    throw new Error(
      "REQUIRE_INTEGRATION=1 but DATABASE_URL is not set; refusing to report a zero-assertion live test run as successful.",
    );
  }
}
