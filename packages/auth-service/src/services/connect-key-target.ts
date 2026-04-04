export interface ConnectKeyTargetCandidate {
  id: string;
  label: string | null;
  createdAt: Date;
}

export type ConnectKeyTargetSelection =
  | {
      action: "create";
    }
  | {
      action: "update";
      connectionId: string;
    }
  | {
      action: "conflict";
      candidates: ConnectKeyTargetCandidate[];
    };

function normalizeLabel(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function selectConnectKeyTarget(input: {
  label?: string | null;
  activeConnections: ConnectKeyTargetCandidate[];
}): ConnectKeyTargetSelection {
  const normalizedLabel = normalizeLabel(input.label);
  const matchingConnections = normalizedLabel
    ? input.activeConnections.filter(
        (connection) => normalizeLabel(connection.label) === normalizedLabel
      )
    : input.activeConnections;

  if (matchingConnections.length === 1) {
    return {
      action: "update",
      connectionId: matchingConnections[0].id,
    };
  }

  if (matchingConnections.length > 1) {
    return {
      action: "conflict",
      candidates: matchingConnections,
    };
  }

  return { action: "create" };
}
