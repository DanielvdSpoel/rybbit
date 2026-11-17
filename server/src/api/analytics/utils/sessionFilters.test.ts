import { describe, expect, it } from "vitest";
import {
  buildFilteredSessionsCTE,
  buildSessionAndRowFilterFragments,
  getSessionFilterStatement,
} from "./sessionFilters.js";

const SITE_ID = 1;
const timeStatement = "AND timestamp >= toDateTime('2026-08-01 00:00:00')";

const build = (parameter: string, value: string) =>
  buildFilteredSessionsCTE(JSON.stringify([{ parameter, type: "equals", value: [value] }]), SITE_ID, timeStatement)!;

describe("buildFilteredSessionsCTE", () => {
  it("projects only the aggregate needed by a UTM filter", () => {
    const sql = build("utm_campaign", "launch");

    expect(sql).toContain("argMinIf(url_parameters['utm_campaign'], timestamp, url_parameters['utm_campaign'] != '') AS utm_campaign");
    expect(sql).not.toContain("argMax(browser,");
    expect(sql).not.toContain("AS utm_source");
    expect(sql).not.toContain("feature_flags");
  });

  it("projects the component columns needed by transformed filters", () => {
    const sql = build("browser_version", "Chrome 140");

    expect(sql).toContain("argMax(browser, timestamp) AS browser");
    expect(sql).toContain("argMax(browser_version, timestamp) AS browser_version");
    expect(sql).not.toContain("argMax(country,");
  });

  it("uses membership subqueries without projecting unrelated event fields", () => {
    const sql = build("pathname", "/pricing");

    expect(sql).toContain("session_id IN (");
    expect(sql).toContain("pathname = '/pricing'");
    expect(sql).not.toContain("argMax(pathname,");
    expect(sql).not.toContain("argMax(browser,");
  });
});

// FORK: properties:<key> / url_param:<key> read the raw props / url_parameters
// columns, which the per-session aggregate does not project. They used to fall
// through to `argMax(properties:vendor_id, timestamp) AS properties:vendor_id`,
// a ClickHouse syntax error that broke overview, time-series and every metric.
describe("buildFilteredSessionsCTE with properties:/url_param: filters", () => {
  const buildMany = (filters: unknown[]) => buildFilteredSessionsCTE(JSON.stringify(filters), SITE_ID, timeStatement)!;

  it("filters properties: through an events subquery instead of a session aggregate", () => {
    const sql = buildMany([
      { parameter: "event_name", type: "equals", value: ["product_viewed"] },
      { parameter: "properties:vendor_id", type: "equals", value: ["24"] },
    ]);

    expect(sql).not.toMatch(/AS properties:/);
    expect(sql).not.toContain("argMax(properties:");
    expect(sql).toContain("JSONExtractString(toString(props), 'vendor_id') = '24'");
    expect(sql).toContain("event_name = 'product_viewed'");
    expect(sql.match(/session_id IN \(/g)).toHaveLength(2);
  });

  it("filters url_param: through an events subquery", () => {
    const sql = build("url_param:campaign_id", "fall");

    expect(sql).not.toMatch(/AS url_param:/);
    expect(sql).toContain("session_id IN (");
    expect(sql).toContain("url_parameters['campaign_id'] = 'fall'");
  });

  it("compares properties: numerically inside the subquery", () => {
    const sql = buildMany([{ parameter: "properties:results_count", type: "greater_than", value: ["5"] }]);

    expect(sql).toContain("session_id IN (");
    expect(sql).toContain("toFloat64OrNull(JSONExtractString(toString(props), 'results_count')) > 5");
  });

  it("keeps negated properties: filters as NOT IN membership", () => {
    const sql = buildMany([{ parameter: "properties:vendor_id", type: "not_equals", value: ["24"] }]);

    expect(sql).toContain("session_id NOT IN (");
    expect(sql).toContain("JSONExtractString(toString(props), 'vendor_id') = '24'");
  });
});

describe("getSessionFilterStatement with properties: filters", () => {
  it("uses an events subquery so the sessions CTE needs no props column", () => {
    const sql = getSessionFilterStatement(
      JSON.stringify([{ parameter: "properties:vendor_id", type: "equals", value: ["24"] }]),
      SITE_ID,
      timeStatement
    );

    expect(sql).toContain("session_id IN (");
    expect(sql).toContain("FROM events");
    expect(sql).toContain("JSONExtractString(toString(props), 'vendor_id') = '24'");
  });
});

describe("buildSessionAndRowFilterFragments with properties: filters", () => {
  it("qualifies the session for metric reports without an invalid alias", () => {
    const { filteredSessionsCTE, rowFilterStatement } = buildSessionAndRowFilterFragments(
      JSON.stringify([
        { parameter: "event_name", type: "equals", value: ["product_viewed"] },
        { parameter: "properties:vendor_id", type: "equals", value: ["24"] },
      ]),
      SITE_ID,
      timeStatement,
      []
    );

    expect(rowFilterStatement).toBe("");
    expect(filteredSessionsCTE).not.toMatch(/AS properties:/);
    expect(filteredSessionsCTE).toContain("JSONExtractString(toString(props), 'vendor_id') = '24'");
  });
});
