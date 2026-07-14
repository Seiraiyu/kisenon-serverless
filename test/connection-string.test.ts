import { describe, test, expect } from "vitest";
import {
  parseConnectionString,
  normalizeConfig,
} from "../src/connection-string.js";

describe("parseConnectionString (task 2.1)", () => {
  test("parses postgres URL", () => {
    const c = parseConnectionString(
      "postgres://u:p%40ss@ep-x1.usc1.kisenon.com/appdb?sslmode=require&options=endpoint%3Dep-x1",
    );
    expect(c).toMatchObject({
      host: "ep-x1.usc1.kisenon.com",
      port: 5432,
      user: "u",
      password: "p@ss",
      database: "appdb",
      ssl: true,
      options: "endpoint=ep-x1",
    });
  });

  test("accepts the postgresql:// scheme too", () => {
    const c = parseConnectionString("postgresql://bob:pw@ep-x.usc1.kisenon.com/db");
    expect(c).toMatchObject({
      host: "ep-x.usc1.kisenon.com",
      port: 5432,
      user: "bob",
      password: "pw",
      database: "db",
      ssl: true,
    });
  });

  test("URL-decodes user and password", () => {
    const c = parseConnectionString(
      "postgres://us%40er:p%40ss%2Fword%3A1@ep-x.usc1.kisenon.com/db",
    );
    expect(c.user).toBe("us@er");
    expect(c.password).toBe("p@ss/word:1");
  });

  test("keeps the host verbatim — no api. rewrite (dodges #2121)", () => {
    const c = parseConnectionString("postgres://u:p@ep-cool-frost-123.usc1.kisenon.com/db");
    expect(c.host).toBe("ep-cool-frost-123.usc1.kisenon.com");
  });

  test("database is the path minus the leading slash", () => {
    const c = parseConnectionString("postgres://u:p@host.usc1.kisenon.com/appdb");
    expect(c.database).toBe("appdb");
  });

  test("port defaults to 5432 and honors an explicit port", () => {
    expect(parseConnectionString("postgres://u:p@host.usc1.kisenon.com/db").port).toBe(5432);
    expect(
      parseConnectionString("postgres://u:p@host.usc1.kisenon.com:6543/db").port,
    ).toBe(6543);
  });

  test("ssl is derived from sslmode: disable -> false, else true", () => {
    expect(parseConnectionString("postgres://u:p@h.usc1.kisenon.com/db").ssl).toBe(true);
    expect(
      parseConnectionString("postgres://u:p@h.usc1.kisenon.com/db?sslmode=require").ssl,
    ).toBe(true);
    expect(
      parseConnectionString("postgres://u:p@h.usc1.kisenon.com/db?sslmode=disable").ssl,
    ).toBe(false);
  });

  test("options is undefined when absent, verbatim when present", () => {
    expect(parseConnectionString("postgres://u:p@h.usc1.kisenon.com/db").options).toBeUndefined();
    expect(
      parseConnectionString(
        "postgres://u:p@generic.example.com/db?options=endpoint%3Dep-sni-less-9",
      ).options,
    ).toBe("endpoint=ep-sni-less-9");
  });

  test("missing password yields empty string", () => {
    const c = parseConnectionString("postgres://alice@h.usc1.kisenon.com/db");
    expect(c.user).toBe("alice");
    expect(c.password).toBe("");
  });

  test("rejects an empty connection string", () => {
    expect(() => parseConnectionString("")).toThrow();
    expect(() => parseConnectionString("   ")).toThrow();
  });

  test("rejects a non-postgres scheme", () => {
    expect(() => parseConnectionString("mysql://u:p@host/db")).toThrow();
  });
});

describe("normalizeConfig (task 2.2)", () => {
  test("a bare connection string delegates to parseConnectionString", () => {
    const s =
      "postgres://u:p%40ss@ep-x1.usc1.kisenon.com/appdb?sslmode=require&options=endpoint%3Dep-x1";
    expect(normalizeConfig(s)).toEqual(parseConnectionString(s));
  });

  test("a { connectionString } object delegates identically", () => {
    const s = "postgres://u:p@ep-x1.usc1.kisenon.com/appdb";
    expect(normalizeConfig({ connectionString: s })).toEqual(parseConnectionString(s));
  });

  test("discrete fields and an equivalent connection string yield the same config", () => {
    const discrete = normalizeConfig({
      host: "ep-x1.usc1.kisenon.com",
      port: 5432,
      user: "u",
      password: "p@ss",
      database: "appdb",
      ssl: true,
    });
    const fromString = parseConnectionString(
      "postgres://u:p%40ss@ep-x1.usc1.kisenon.com/appdb?sslmode=require",
    );
    expect(discrete).toEqual(fromString);
  });

  test("discrete fields fill the ConnectionConfig defaults (port 5432, ssl true)", () => {
    const c = normalizeConfig({ host: "h.usc1.kisenon.com", user: "u", database: "db" });
    expect(c).toMatchObject({
      host: "h.usc1.kisenon.com",
      port: 5432,
      user: "u",
      password: "",
      database: "db",
      ssl: true,
    });
  });

  test("discrete ssl:false is preserved", () => {
    expect(normalizeConfig({ host: "h", user: "u", database: "db", ssl: false }).ssl).toBe(
      false,
    );
  });
});
