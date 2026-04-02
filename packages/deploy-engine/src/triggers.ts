/**
 * Trigger Metadata System
 *
 * Builds trigger metadata (webhook URLs, cron info, etc.) from workflow
 * trigger configs after deployment.
 */

import CronParser from "cron-parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Trigger configuration — mirrors the SDK TriggerConfig to avoid circular deps. */
export interface TriggerConfig {
  type: "webhook" | "schedule" | "event" | "manual";
  /** Webhook path (e.g., "/enrich") */
  path?: string;
  /** Cron expression (e.g., "0 9 * * MON") */
  cron?: string;
  /** Event name (e.g., "lead.created") */
  event?: string;
  config?: {
    schedule?: {
      cron?: string;
      timezone?: string;
      payload?: unknown;
    };
    webhook?: {
      path?: string;
      access?: "public" | "private";
      signature?: {
        header?: string;
        secretRef?: string;
      };
    };
    event?: {
      event?: string;
      source?: string;
      bus?: string;
      topic?: string;
      subscription?: string;
      async?: boolean;
      payload?: unknown;
    };
  };
}

/** Computed trigger metadata for a deployed workflow. */
export interface TriggerInfo {
  workflowId: string;
  type: "webhook" | "schedule" | "event" | "manual";
  webhookUrl?: string;
  cronExpression?: string;
  nextRunTime?: Date;
  timezone?: string;
  eventName?: string;
  eventSourceSummary?: string;
  access?: "public" | "private";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build trigger metadata from a workflow's trigger config and the deployment
 * base URL.
 */
export function buildTriggerInfo(
  trigger: TriggerConfig,
  workflowId: string,
  baseUrl: string,
): TriggerInfo {
  const webhookConfig = trigger.config?.webhook;
  const scheduleConfig = trigger.config?.schedule;
  const eventConfig = trigger.config?.event;
  const info: TriggerInfo = {
    workflowId,
    type: trigger.type,
  };

  switch (trigger.type) {
    case "webhook": {
      const base = baseUrl.replace(/\/+$/, "");
      const path = (webhookConfig?.path ?? trigger.path ?? "").replace(
        /^\/+/,
        "",
      );
      info.webhookUrl = base ? `${base}/${path}` : `/${path}`;
      info.access = webhookConfig?.access ?? "public";
      break;
    }
    case "schedule": {
      const cron = scheduleConfig?.cron ?? trigger.cron;
      if (cron) {
        info.cronExpression = cron;
        info.timezone = scheduleConfig?.timezone;
        const interval = CronParser.parseExpression(cron, {
          tz: scheduleConfig?.timezone,
        });
        info.nextRunTime = interval.next().toDate();
      }
      break;
    }
    case "event": {
      info.eventName = eventConfig?.event ?? trigger.event;
      info.eventSourceSummary =
        eventConfig?.source ||
        eventConfig?.topic ||
        eventConfig?.subscription ||
        eventConfig?.bus;
      break;
    }
    case "manual":
      // Nothing extra to set for manual triggers.
      break;
  }

  return info;
}

/**
 * Build trigger info for all workflows given their configs and the deployment
 * base URL.
 */
export function buildAllTriggerInfo(
  workflows: Array<{ id: string; trigger: TriggerConfig }>,
  baseUrl: string,
): TriggerInfo[] {
  return workflows.map((w) => buildTriggerInfo(w.trigger, w.id, baseUrl));
}

/**
 * Format a TriggerInfo for CLI display.
 */
export function formatTriggerInfo(info: TriggerInfo): {
  workflowId: string;
  type: string;
  endpoint: string;
  schedule: string;
} {
  let endpoint = "-";
  let schedule = "-";

  if (info.type === "webhook" && info.webhookUrl) {
    endpoint = info.webhookUrl;
  }

  if (info.type === "schedule" && info.cronExpression) {
    schedule = info.nextRunTime
      ? `${info.cronExpression}${info.timezone ? ` ${info.timezone}` : ""} (next: ${info.nextRunTime.toISOString()})`
      : `${info.cronExpression}${info.timezone ? ` ${info.timezone}` : ""}`;
  }

  if (info.type === "event") {
    endpoint = info.eventName || "-";
    schedule = info.eventSourceSummary || "-";
  }

  return {
    workflowId: info.workflowId,
    type: info.type,
    endpoint,
    schedule,
  };
}
