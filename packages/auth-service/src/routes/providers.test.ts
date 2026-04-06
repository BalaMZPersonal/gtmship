import assert from "node:assert/strict";
import test from "node:test";
import {
  getProviderRuntimeSecretSyncState,
  providerRuntimeSecretFieldsChanged,
} from "./providers.js";

test("providerRuntimeSecretFieldsChanged ignores header ordering differences", () => {
  const previous = getProviderRuntimeSecretSyncState({
    authType: "api_key",
    baseUrl: "https://api.example.com",
    headerName: "X-API-Key",
    defaultHeaders: {
      "X-Team": "revops",
      "X-Region": "us",
    },
  });
  const next = getProviderRuntimeSecretSyncState({
    authType: "api_key",
    baseUrl: "https://api.example.com",
    headerName: "X-API-Key",
    defaultHeaders: {
      "X-Region": "us",
      "X-Team": "revops",
    },
  });

  assert.equal(providerRuntimeSecretFieldsChanged(previous, next), false);
});

test("providerRuntimeSecretFieldsChanged tracks runtime auth metadata changes", () => {
  const previous = getProviderRuntimeSecretSyncState({
    authType: "api_key",
    baseUrl: "https://api.example.com",
    headerName: "X-API-Key",
    defaultHeaders: {
      "X-Team": "revops",
    },
  });
  const next = getProviderRuntimeSecretSyncState({
    authType: "basic",
    baseUrl: "https://api-v2.example.com",
    headerName: "Authorization",
    defaultHeaders: {
      "X-Team": "revops",
    },
  });

  assert.equal(providerRuntimeSecretFieldsChanged(previous, next), true);
});
