import assert from "node:assert/strict";
import test from "node:test";
import { buildProxyUpstreamUrl } from "./proxy.js";

test("buildProxyUpstreamUrl preserves provider query parameters", () => {
  const url = buildProxyUpstreamUrl(
    "https://sheets.googleapis.com",
    "/v4/spreadsheets/spreadsheet-id/values/Sheet1!A1:append",
    "/proxy/google-sheets/v4/spreadsheets/spreadsheet-id/values/Sheet1!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"
  );

  assert.equal(
    url,
    "https://sheets.googleapis.com/v4/spreadsheets/spreadsheet-id/values/Sheet1!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"
  );
});

test("buildProxyUpstreamUrl leaves URLs without queries unchanged", () => {
  const url = buildProxyUpstreamUrl(
    "https://api.example.com",
    "/v1/accounts/factors.ai/journey",
    "/proxy/factors/v1/accounts/factors.ai/journey"
  );

  assert.equal(url, "https://api.example.com/v1/accounts/factors.ai/journey");
});
