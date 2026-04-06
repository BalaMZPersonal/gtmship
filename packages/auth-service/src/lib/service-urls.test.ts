import assert from "node:assert/strict";
import test from "node:test";
import {
  getAllowedWebOrigins,
  isAllowedWebOrigin,
  parseOriginList,
} from "./service-urls.js";

const ORIGINAL_ENV = {
  DASHBOARD_URL: process.env.DASHBOARD_URL,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  HOMEPAGE_URL: process.env.HOMEPAGE_URL,
};

function restoreEnv() {
  process.env.DASHBOARD_URL = ORIGINAL_ENV.DASHBOARD_URL;
  process.env.CORS_ORIGIN = ORIGINAL_ENV.CORS_ORIGIN;
  process.env.CORS_ORIGINS = ORIGINAL_ENV.CORS_ORIGINS;
  process.env.HOMEPAGE_URL = ORIGINAL_ENV.HOMEPAGE_URL;
}

test.afterEach(() => {
  restoreEnv();
});

test("parseOriginList trims entries and removes blanks", () => {
  assert.deepEqual(
    parseOriginList(
      " https://app.example.com/ , , https://www.example.com/docs/ "
    ),
    ["https://app.example.com", "https://www.example.com"]
  );
});

test("getAllowedWebOrigins combines dashboard, homepage, and extra origins", () => {
  process.env.DASHBOARD_URL = "https://app.gtmship.com/";
  process.env.HOMEPAGE_URL = "https://gtmship.com/";
  process.env.CORS_ORIGINS =
    "https://www.gtmship.com, https://staging.gtmship.com/, https://app.gtmship.com";

  assert.deepEqual(getAllowedWebOrigins(), [
    "https://app.gtmship.com",
    "https://gtmship.com",
    "https://www.gtmship.com",
    "https://staging.gtmship.com",
  ]);
});

test("isAllowedWebOrigin accepts normalized allowlisted origins and null-style origins", () => {
  const allowedOrigins = ["https://app.gtmship.com", "https://www.gtmship.com"];

  assert.equal(
    isAllowedWebOrigin("https://www.gtmship.com/", allowedOrigins),
    true
  );
  assert.equal(isAllowedWebOrigin(undefined, allowedOrigins), true);
  assert.equal(isAllowedWebOrigin("null", allowedOrigins), true);
  assert.equal(isAllowedWebOrigin("https://evil.example.com", allowedOrigins), false);
});
