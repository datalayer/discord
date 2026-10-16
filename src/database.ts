import pg from "pg";

/** The service's PostgreSQL pool (CNPG on r1): bounded, every statement timed out. */
export function createDatabase(connectionString: string): pg.Pool {
  return new pg.Pool({
    application_name: "datalayer-discord",
    connectionString,
    max: 10,
    statement_timeout: 15_000,
  });
}
