import assert from "node:assert/strict";
import test from "node:test";
import { selectConnectKeyTarget } from "./connect-key-target.js";

test("selectConnectKeyTarget creates a new connection when none exist", () => {
  const result = selectConnectKeyTarget({
    label: "freshdesk-primary",
    activeConnections: [],
  });

  assert.deepEqual(result, { action: "create" });
});

test("selectConnectKeyTarget updates the only active connection when no label is provided", () => {
  const result = selectConnectKeyTarget({
    activeConnections: [
      {
        id: "conn_1",
        label: "freshdesk-primary",
        createdAt: new Date("2026-04-04T03:30:00.000Z"),
      },
    ],
  });

  assert.deepEqual(result, {
    action: "update",
    connectionId: "conn_1",
  });
});

test("selectConnectKeyTarget updates the matching labeled connection", () => {
  const result = selectConnectKeyTarget({
    label: "freshdesk-primary",
    activeConnections: [
      {
        id: "conn_2",
        label: "freshdesk-secondary",
        createdAt: new Date("2026-04-04T03:31:00.000Z"),
      },
      {
        id: "conn_1",
        label: "freshdesk-primary",
        createdAt: new Date("2026-04-04T03:30:00.000Z"),
      },
    ],
  });

  assert.deepEqual(result, {
    action: "update",
    connectionId: "conn_1",
  });
});

test("selectConnectKeyTarget reports conflicts when multiple active matches exist", () => {
  const candidates = [
    {
      id: "conn_2",
      label: "freshdesk-primary",
      createdAt: new Date("2026-04-04T03:31:00.000Z"),
    },
    {
      id: "conn_1",
      label: "freshdesk-primary",
      createdAt: new Date("2026-04-04T03:30:00.000Z"),
    },
  ];
  const result = selectConnectKeyTarget({
    label: "freshdesk-primary",
    activeConnections: candidates,
  });

  assert.deepEqual(result, {
    action: "conflict",
    candidates,
  });
});
