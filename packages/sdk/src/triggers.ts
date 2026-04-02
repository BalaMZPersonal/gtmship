import type {
  TriggerConfig,
  WorkflowEventTriggerConfiguration,
  WorkflowScheduleTriggerConfiguration,
  WorkflowWebhookTriggerConfiguration,
} from "./types.js";

/**
 * Trigger builders for GTMShip workflows.
 *
 * @example
 * ```ts
 * triggers.manual()               // Manual/run-now trigger
 * triggers.webhook("/enrich")      // HTTP POST trigger
 * triggers.schedule("0 9 * * MON") // Every Monday at 9am
 * triggers.event("lead.created")   // Custom event trigger
 * ```
 */
export const triggers = {
  /** Trigger workflow manually from the dashboard or preview runner */
  manual(): TriggerConfig {
    return { type: "manual" };
  },

  /** Trigger workflow via an incoming HTTP webhook */
  webhook(
    path: string,
    options?: Omit<WorkflowWebhookTriggerConfiguration, "path">
  ): TriggerConfig {
    if (!path.startsWith("/")) {
      path = `/${path}`;
    }
    return {
      type: "webhook",
      path,
      config: {
        webhook: {
          path,
          ...options,
        },
      },
    };
  },

  /** Trigger workflow on a cron schedule */
  schedule(
    cron: string,
    options?: Omit<WorkflowScheduleTriggerConfiguration, "cron">
  ): TriggerConfig {
    return {
      type: "schedule",
      cron,
      config: {
        schedule: {
          cron,
          ...options,
        },
      },
    };
  },

  /** Trigger workflow when a custom event is emitted */
  event(
    eventName: string,
    options?: Omit<WorkflowEventTriggerConfiguration, "event">
  ): TriggerConfig {
    return {
      type: "event",
      event: eventName,
      config: {
        event: {
          event: eventName,
          ...options,
        },
      },
    };
  },
};
