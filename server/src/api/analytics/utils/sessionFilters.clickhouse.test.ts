import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFilteredSessionsCTE } from "./sessionFilters.js";

// Run against any ClickHouse using CLICKHOUSE_TEST_URL and optional
// CLICKHOUSE_TEST_USER / CLICKHOUSE_TEST_PASSWORD. The query supplies its own
// events CTE: no tables, migrations or production data are needed.
//
// FORK: properties:<key> / url_param:<key> filters used to render
// `argMax(properties:vendor_id, timestamp) AS properties:vendor_id`, which
// ClickHouse rejects; this pins that the CTE parses and selects the right
// sessions with a real JSON props column.

// site, time, session, event_name, props (JSON), url_parameters
const events: [number, string, string, string, string, Record<string, string>][] = [
  [35, "2026-10-05 10:00:00", "sA", "", "{}", { campaign_id: "fall" }],
  [35, "2026-10-05 10:01:00", "sA", "product_viewed", '{"vendor_id":"24","product_id":"p1"}', {}],
  [35, "2026-10-12 10:01:00", "sB", "product_viewed", '{"vendor_id":"7","product_id":"p2"}', {}],
  [35, "2026-10-20 10:01:00", "sC", "search_performed", '{"results_count":0}', {}],
  [35, "2026-10-21 10:01:00", "sD", "search_performed", '{"results_count":12}', {}],
  // Another site with a matching vendor must not leak in.
  [36, "2026-10-05 10:01:00", "sX", "product_viewed", '{"vendor_id":"24"}', {}],
];
const mapLiteral = (map: Record<string, string>) =>
  `map(${Object.entries(map)
    .flatMap(([key, value]) => [`'${key}'`, `'${value}'`])
    .join(", ")})`;
const fixture = `events AS (
  SELECT site_id, timestamp, session_id, event_name, CAST(props_text, 'JSON') AS props,
    CAST(url_parameters, 'Map(String, String)') AS url_parameters
  FROM (
    ${events
      .map(
        ([site, time, session, eventName, props, urlParameters]) =>
          `SELECT toInt32(${site}) AS site_id, toDateTime('${time}', 'UTC') AS timestamp, '${session}' AS session_id,
            '${eventName}' AS event_name, '${props}' AS props_text, ${mapLiteral(urlParameters)} AS url_parameters`
      )
      .join("\n    UNION ALL ")}
  )
)`;

const timeStatement = "AND timestamp >= toDateTime('2026-10-01 00:00:00', 'UTC')";

describe.skipIf(!process.env.CLICKHOUSE_TEST_URL)("Filtered sessions: properties:/url_param: on ClickHouse", () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(() => {
    client = createClient({
      url: process.env.CLICKHOUSE_TEST_URL,
      username: process.env.CLICKHOUSE_TEST_USER || "default",
      password: process.env.CLICKHOUSE_TEST_PASSWORD || "",
      compression: { request: false, response: false },
      clickhouse_settings: { readonly: "2", max_threads: 2, max_execution_time: 10 },
    });
  });
  afterAll(async () => {
    await client.close();
  });

  async function sessionsMatching(filters: unknown[]): Promise<string[]> {
    const cte = buildFilteredSessionsCTE(JSON.stringify(filters), 35, timeStatement);
    const result = await client.query({
      query: `WITH ${fixture}, ${cte} SELECT session_id FROM FilteredSessions ORDER BY session_id`,
      format: "JSONEachRow",
    });
    return (await result.json<{ session_id: string }>()).map(row => row.session_id);
  }

  it("combines an event_name filter with a properties: filter", async () => {
    await expect(
      sessionsMatching([
        { parameter: "event_name", type: "equals", value: ["product_viewed"] },
        { parameter: "properties:vendor_id", type: "equals", value: ["24"] },
      ])
    ).resolves.toEqual(["sA"]);
  });

  it("matches a numeric JSON property by its string form", async () => {
    await expect(
      sessionsMatching([{ parameter: "properties:results_count", type: "equals", value: ["0"] }])
    ).resolves.toEqual(["sC"]);
  });

  it("compares properties: numerically, not as strings", async () => {
    // As strings '12' > '5' is false, so a string compare would drop sD.
    await expect(
      sessionsMatching([{ parameter: "properties:results_count", type: "greater_than", value: ["5"] }])
    ).resolves.toEqual(["sD"]);
  });

  it("excludes sessions with a matching event for not_equals", async () => {
    await expect(
      sessionsMatching([{ parameter: "properties:vendor_id", type: "not_equals", value: ["24"] }])
    ).resolves.toEqual(["sB", "sC", "sD"]);
  });

  it("filters on url_param:", async () => {
    await expect(
      sessionsMatching([{ parameter: "url_param:campaign_id", type: "equals", value: ["fall"] }])
    ).resolves.toEqual(["sA"]);
  });
});
