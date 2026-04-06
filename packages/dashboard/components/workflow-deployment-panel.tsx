"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  WorkflowBinding,
  WorkflowBindingSelectorType,
  WorkflowDeploymentPlan,
  WorkflowStudioArtifact,
} from "@/lib/workflow-studio/types";

interface ConnectionRecord {
  id: string;
  label?: string | null;
  createdAt?: string;
  status: string;
  provider: {
    slug: string;
    name: string;
  };
}

interface WorkflowDeploymentPanelProps {
  artifact: WorkflowStudioArtifact;
  plan: WorkflowDeploymentPlan | null;
  planning: boolean;
  connections: ConnectionRecord[];
  onArtifactChange: (
    updater: (current: WorkflowStudioArtifact) => WorkflowStudioArtifact
  ) => void;
}

function normalizeBindings(artifact: WorkflowStudioArtifact): WorkflowBinding[] {
  return artifact.bindings || [];
}

function upsertBinding(
  bindings: WorkflowBinding[],
  providerSlug: string,
  nextBinding: WorkflowBinding
): WorkflowBinding[] {
  const next = [...bindings];
  const index = next.findIndex((binding) => binding.providerSlug === providerSlug);

  if (index >= 0) {
    next[index] = nextBinding;
  } else {
    next.push(nextBinding);
  }

  return next;
}

export function WorkflowDeploymentPanel({
  artifact,
  plan,
  planning,
  connections,
  onArtifactChange,
}: WorkflowDeploymentPanelProps) {
  const bindings = normalizeBindings(artifact);
  const integrationProviders = Array.from(
    new Set([
      ...artifact.requiredAccesses
        .map((access) => access.providerSlug)
        .filter(Boolean),
      ...bindings.map((binding) => binding.providerSlug),
    ])
  ) as string[];
  const triggerType = plan?.trigger.type || artifact.validation?.details.triggerType || "manual";

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Deployment Spec
        </h4>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-xs text-zinc-400">
            Provider
            <select
              value={artifact.deploy?.provider || ""}
              onChange={(event) =>
                onArtifactChange((current) => ({
                  ...current,
                  deploy: {
                    ...(current.deploy || {}),
                    provider: (event.target.value || undefined) as
                      | "aws"
                      | "gcp"
                      | "local"
                      | undefined,
                  },
                }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
            >
              <option value="">Project default</option>
              <option value="aws">AWS</option>
              <option value="gcp">GCP</option>
              <option value="local">Local</option>
            </select>
          </label>

          <label className="text-xs text-zinc-400">
            Region
            <input
              value={artifact.deploy?.region || ""}
              onChange={(event) =>
                onArtifactChange((current) => ({
                  ...current,
                  deploy: {
                    ...(current.deploy || {}),
                    region: event.target.value || undefined,
                  },
                }))
              }
              placeholder="Use project default"
              className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
            />
          </label>

          {artifact.deploy?.provider !== "local" ? (
            <label className="text-xs text-zinc-400">
              GCP Project
              <input
                value={artifact.deploy?.gcpProject || ""}
                onChange={(event) =>
                  onArtifactChange((current) => ({
                    ...current,
                    deploy: {
                      ...(current.deploy || {}),
                      gcpProject: event.target.value || undefined,
                    },
                  }))
                }
                placeholder="Required for GCP deploys"
                className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
              />
            </label>
          ) : null}

          <label className="text-xs text-zinc-400">
            Execution Kind
            <select
              value={artifact.deploy?.execution?.kind || ""}
              onChange={(event) =>
                onArtifactChange((current) => ({
                  ...current,
                  deploy: {
                    ...(current.deploy || {}),
                    execution: {
                      ...(current.deploy?.execution || {}),
                      kind: (event.target.value || undefined) as "service" | "job" | undefined,
                    },
                  },
                }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
            >
              <option value="">Planner default</option>
              <option value="service">service</option>
              <option value="job">job</option>
            </select>
          </label>

          <label className="text-xs text-zinc-400">
            Auth Mode
            <select
              value={
                artifact.deploy?.auth?.mode === "synced_secrets"
                  ? "secret_manager"
                  : artifact.deploy?.auth?.mode || "proxy"
              }
              onChange={(event) =>
                onArtifactChange((current) => ({
                  ...current,
                  deploy: {
                    ...(current.deploy || {}),
                    auth: {
                      ...(current.deploy?.auth || {}),
                      mode: (event.target.value || "proxy") as
                        | "proxy"
                        | "secret_manager",
                    },
                  },
                }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
            >
              <option value="proxy">proxy</option>
              <option value="secret_manager">secret_manager</option>
            </select>
          </label>

          {(artifact.deploy?.auth?.mode === "secret_manager" ||
            artifact.deploy?.auth?.mode === "synced_secrets") ? (
            <>
              <label className="text-xs text-zinc-400">
                Secret Backend
                <select
                  value={artifact.deploy?.auth?.backend?.kind || ""}
                  onChange={(event) =>
                    onArtifactChange((current) => ({
                      ...current,
                      deploy: {
                        ...(current.deploy || {}),
                        auth: {
                          ...(current.deploy?.auth || {}),
                          backend: {
                            ...(current.deploy?.auth?.backend || {}),
                            kind: (event.target.value || undefined) as
                              | "aws_secrets_manager"
                              | "gcp_secret_manager"
                              | undefined,
                          },
                        },
                      },
                    }))
                  }
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                >
                  <option value="">Select backend</option>
                  <option value="aws_secrets_manager">aws_secrets_manager</option>
                  <option value="gcp_secret_manager">gcp_secret_manager</option>
                </select>
              </label>

              <label className="text-xs text-zinc-400">
                Runtime Access
                <select
                  value={artifact.deploy?.auth?.runtimeAccess || "direct"}
                  onChange={(event) =>
                    onArtifactChange((current) => ({
                      ...current,
                      deploy: {
                        ...(current.deploy || {}),
                        auth: {
                          ...(current.deploy?.auth || {}),
                          runtimeAccess: (event.target.value || "direct") as
                            | "direct"
                            | "local_cache",
                        },
                      },
                    }))
                  }
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                >
                  <option value="direct">direct</option>
                  <option value="local_cache">local_cache</option>
                </select>
              </label>

              <label className="text-xs text-zinc-400">
                Secret Prefix
                <input
                  value={artifact.deploy?.auth?.backend?.secretPrefix || ""}
                  onChange={(event) =>
                    onArtifactChange((current) => ({
                      ...current,
                      deploy: {
                        ...(current.deploy || {}),
                        auth: {
                          ...(current.deploy?.auth || {}),
                          backend: {
                            ...(current.deploy?.auth?.backend || {}),
                            secretPrefix: event.target.value || undefined,
                          },
                        },
                      },
                    }))
                  }
                  placeholder="gtmship-connections"
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                />
              </label>

              {artifact.deploy?.auth?.backend?.kind ===
              "aws_secrets_manager" ? (
                <label className="text-xs text-zinc-400">
                  Secret Region
                  <input
                    value={artifact.deploy?.auth?.backend?.region || ""}
                    onChange={(event) =>
                      onArtifactChange((current) => ({
                        ...current,
                        deploy: {
                          ...(current.deploy || {}),
                          auth: {
                            ...(current.deploy?.auth || {}),
                            backend: {
                              ...(current.deploy?.auth?.backend || {}),
                              region: event.target.value || undefined,
                            },
                          },
                        },
                      }))
                    }
                    placeholder="us-east-1"
                    className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                  />
                </label>
              ) : null}

              {artifact.deploy?.auth?.backend?.kind ===
              "gcp_secret_manager" ? (
                <label className="text-xs text-zinc-400">
                  Secret Project ID
                  <input
                    value={artifact.deploy?.auth?.backend?.projectId || ""}
                    onChange={(event) =>
                      onArtifactChange((current) => ({
                        ...current,
                        deploy: {
                          ...(current.deploy || {}),
                          auth: {
                            ...(current.deploy?.auth || {}),
                            backend: {
                              ...(current.deploy?.auth?.backend || {}),
                              projectId: event.target.value || undefined,
                            },
                          },
                        },
                      }))
                    }
                    placeholder="my-gcp-project"
                    className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                  />
                </label>
              ) : null}
            </>
          ) : null}

          <label className="text-xs text-zinc-400">
            Timeout Seconds
            <input
              type="number"
              min={0}
              value={artifact.deploy?.timeoutSeconds || ""}
              onChange={(event) =>
                onArtifactChange((current) => ({
                  ...current,
                  deploy: {
                    ...(current.deploy || {}),
                    timeoutSeconds: event.target.value
                      ? Number(event.target.value)
                      : undefined,
                  },
                }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
            />
          </label>

          <label className="text-xs text-zinc-400">
            Memory
            <input
              value={artifact.deploy?.memory || ""}
              onChange={(event) =>
                onArtifactChange((current) => ({
                  ...current,
                  deploy: {
                    ...(current.deploy || {}),
                    memory: event.target.value || undefined,
                  },
                }))
              }
              placeholder="256, 512Mi, 1024"
              className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
            />
          </label>

          <label className="text-xs text-zinc-400">
            CPU
            <input
              value={artifact.deploy?.cpu || ""}
              onChange={(event) =>
                onArtifactChange((current) => ({
                  ...current,
                  deploy: {
                    ...(current.deploy || {}),
                    cpu: event.target.value || undefined,
                  },
                }))
              }
              placeholder="1, 2"
              className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
            />
          </label>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {triggerType === "schedule" ? (
            <>
              <label className="text-xs text-zinc-400">
                Schedule Cron
                <input
                  value={artifact.triggerConfig?.schedule?.cron || ""}
                  onChange={(event) =>
                    onArtifactChange((current) => ({
                      ...current,
                      triggerConfig: {
                        ...(current.triggerConfig || {}),
                        schedule: {
                          ...(current.triggerConfig?.schedule || {}),
                          cron: event.target.value || undefined,
                        },
                      },
                    }))
                  }
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                />
              </label>
              <label className="text-xs text-zinc-400">
                Timezone
                <input
                  value={artifact.triggerConfig?.schedule?.timezone || ""}
                  onChange={(event) =>
                    onArtifactChange((current) => ({
                      ...current,
                      triggerConfig: {
                        ...(current.triggerConfig || {}),
                        schedule: {
                          ...(current.triggerConfig?.schedule || {}),
                          timezone: event.target.value || undefined,
                        },
                      },
                    }))
                  }
                  placeholder="UTC"
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                />
              </label>
            </>
          ) : null}

          {triggerType === "webhook" ? (
            <>
              <label className="text-xs text-zinc-400">
                Webhook Path
                <input
                  value={artifact.triggerConfig?.webhook?.path || ""}
                  onChange={(event) =>
                    onArtifactChange((current) => ({
                      ...current,
                      triggerConfig: {
                        ...(current.triggerConfig || {}),
                        webhook: {
                          ...(current.triggerConfig?.webhook || {}),
                          path: event.target.value || undefined,
                        },
                      },
                    }))
                  }
                  placeholder="/incoming"
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                />
              </label>
              <label className="text-xs text-zinc-400">
                Visibility
                <select
                  value={artifact.triggerConfig?.webhook?.visibility || "public"}
                  onChange={(event) =>
                    onArtifactChange((current) => ({
                      ...current,
                      triggerConfig: {
                        ...(current.triggerConfig || {}),
                        webhook: {
                          ...(current.triggerConfig?.webhook || {}),
                          visibility: (event.target.value || "public") as "public" | "private",
                        },
                      },
                    }))
                  }
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                >
                  <option value="public">public</option>
                  <option value="private">private</option>
                </select>
              </label>
              <label className="text-xs text-zinc-400 md:col-span-2">
                Signature Header
                <input
                  value={artifact.triggerConfig?.webhook?.signatureHeader || ""}
                  onChange={(event) =>
                    onArtifactChange((current) => ({
                      ...current,
                      triggerConfig: {
                        ...(current.triggerConfig || {}),
                        webhook: {
                          ...(current.triggerConfig?.webhook || {}),
                          signatureHeader: event.target.value || undefined,
                        },
                      },
                    }))
                  }
                  placeholder="x-signature"
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                />
              </label>
            </>
          ) : null}

          {triggerType === "event" ? (
            <label className="text-xs text-zinc-400 md:col-span-2">
              Event Source
              <input
                value={artifact.triggerConfig?.event?.source || ""}
                onChange={(event) =>
                  onArtifactChange((current) => ({
                    ...current,
                    triggerConfig: {
                      ...(current.triggerConfig || {}),
                      event: {
                        ...(current.triggerConfig?.event || {}),
                        source: event.target.value || undefined,
                      },
                    },
                  }))
                }
                placeholder="eventarc, eventbridge, topic name, queue, or source id"
                className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
              />
            </label>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Connection Bindings
        </h4>
        {integrationProviders.length === 0 ? (
          <p className="mt-3 text-xs text-zinc-600">
            Bindings appear once the workflow needs one or more integrations.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {integrationProviders.map((providerSlug) => {
              const binding =
                bindings.find((entry) => entry.providerSlug === providerSlug) || {
                  providerSlug,
                  selector: { type: "latest_active" as WorkflowBindingSelectorType },
                };
              const providerConnections = connections.filter(
                (connection) =>
                  connection.status === "active" &&
                  connection.provider.slug === providerSlug
              );

              return (
                <div
                  key={providerSlug}
                  className="rounded-lg border border-zinc-800 px-3 py-3"
                >
                  <div className="grid gap-3 md:grid-cols-[180px,180px,1fr]">
                    <div>
                      <p className="text-sm font-medium text-white">
                        {providerSlug}
                      </p>
                      <p className="mt-1 text-[11px] text-zinc-600">
                        {providerConnections.length} active connection
                        {providerConnections.length === 1 ? "" : "s"}
                      </p>
                    </div>

                    <label className="text-xs text-zinc-400">
                      Selector
                      <select
                        value={binding.selector.type}
                        onChange={(event) =>
                          onArtifactChange((current) => ({
                            ...current,
                            bindings: upsertBinding(
                              normalizeBindings(current),
                              providerSlug,
                              {
                                providerSlug,
                                selector: {
                                  type: event.target.value as WorkflowBindingSelectorType,
                                },
                              }
                            ),
                          }))
                        }
                        className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                      >
                        <option value="latest_active">latest_active</option>
                        <option value="connection_id">connection_id</option>
                        <option value="label">label</option>
                      </select>
                    </label>

                    {binding.selector.type === "connection_id" ? (
                      <label className="text-xs text-zinc-400">
                        Connection
                        <select
                          value={binding.selector.connectionId || ""}
                          onChange={(event) =>
                            onArtifactChange((current) => ({
                              ...current,
                              bindings: upsertBinding(
                                normalizeBindings(current),
                                providerSlug,
                                {
                                  providerSlug,
                                  selector: {
                                    type: "connection_id",
                                    connectionId: event.target.value || undefined,
                                  },
                                }
                              ),
                            }))
                          }
                          className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                        >
                          <option value="">Select a connection</option>
                          {providerConnections.map((connection) => (
                            <option key={connection.id} value={connection.id}>
                              {connection.label || connection.id}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : binding.selector.type === "label" ? (
                      <label className="text-xs text-zinc-400">
                        Label
                        <input
                          value={binding.selector.label || ""}
                          onChange={(event) =>
                            onArtifactChange((current) => ({
                              ...current,
                              bindings: upsertBinding(
                                normalizeBindings(current),
                                providerSlug,
                                {
                                  providerSlug,
                                  selector: {
                                    type: "label",
                                    label: event.target.value || undefined,
                                  },
                                }
                              ),
                            }))
                          }
                          placeholder="production"
                          className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
                        />
                      </label>
                    ) : (
                      <div className="rounded-lg border border-dashed border-zinc-800 px-3 py-2 text-xs text-zinc-600">
                        Uses the latest active connection unless you pin a specific one.
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Deployment Plan
            </h4>
            <p className="mt-1 text-xs text-zinc-600">
              Trigger, execution kind, resources, auth bindings, and rollout warnings.
            </p>
          </div>
          {planning ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 size={12} className="animate-spin" />
              Planning...
            </div>
          ) : null}
        </div>

        {plan ? (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-zinc-800 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Trigger
                </p>
                <p className="mt-1 text-sm text-white">{plan.trigger.description}</p>
              </div>
              <div className="rounded-lg border border-zinc-800 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Execution
                </p>
                <p className="mt-1 text-sm text-white">
                  {plan.executionKind}
                  <span className="ml-2 text-[11px] text-zinc-500">
                    {plan.executionSource}
                  </span>
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Provider
                </p>
                <p className="mt-1 text-sm text-white">
                  {plan.provider} / {plan.region}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Auth
                </p>
                <p className="mt-1 text-sm text-white">{plan.authMode}</p>
              </div>
            </div>

            <div>
              <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                Planned Resources
              </p>
              <div className="mt-2 space-y-2">
                {plan.resources.map((resource) => (
                  <div
                    key={`${resource.kind}-${resource.name}`}
                    className="rounded-lg border border-zinc-800 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-white">
                        {resource.kind}
                      </p>
                      <span className="text-[11px] text-zinc-500">
                        {resource.name}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">
                      {resource.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {plan.bindings.length > 0 ? (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Binding Resolution
                </p>
                <div className="mt-2 space-y-2">
                  {plan.bindings.map((binding) => (
                    <div
                      key={binding.providerSlug}
                      className="rounded-lg border border-zinc-800 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-white">
                          {binding.providerSlug}
                        </p>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px]",
                            binding.status === "resolved"
                              ? "bg-emerald-500/10 text-emerald-300"
                              : binding.status === "ambiguous"
                                ? "bg-amber-500/10 text-amber-200"
                                : "bg-rose-500/10 text-rose-200"
                          )}
                        >
                          {binding.status}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">
                        {binding.message}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {plan.warnings.length > 0 ? (
              <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-3 text-xs text-amber-100">
                <p className="font-medium">Warnings</p>
                <ul className="mt-2 space-y-1 text-amber-200/90">
                  {plan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 text-xs text-zinc-600">
            Save or edit the workflow to generate a deployment plan.
          </p>
        )}
      </div>
    </div>
  );
}
