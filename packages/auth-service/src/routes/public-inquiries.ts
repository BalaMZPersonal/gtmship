import axios from "axios";
import { Router } from "express";

export const publicInquiryRoutes: Router = Router();

const VALID_INTERESTS = new Set(["hosted", "services", "both"]);
const VALID_VOLUME_BANDS = new Set(["lt5k", "5k_50k", "gt50k", "unsure"]);
const VALID_TIMELINES = new Set(["asap", "month", "quarter", "exploring"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type PricingInquiry = {
  name: string;
  workEmail: string;
  company: string;
  interest: "hosted" | "services" | "both";
  volumeBand: "lt5k" | "5k_50k" | "gt50k" | "unsure";
  timeline: "asap" | "month" | "quarter" | "exploring";
  stack: string;
  details: string;
  website: string;
};

export type PricingInquiryRequestMeta = {
  submittedAt: string;
  origin: string | null;
  referer: string | null;
  userAgent: string | null;
  forwardedFor: string | null;
  ip: string | null;
};

type ValidationResult =
  | { inquiry: PricingInquiry; error?: never }
  | { inquiry?: never; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function normalizeText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function requireText(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
  error: string
): ValidationResult | string {
  const normalized = normalizeText(record[key], maxLength);
  if (!normalized) {
    return { error };
  }

  return normalized;
}

export function parsePricingInquiry(body: unknown): ValidationResult {
  const record = asRecord(body);
  if (!record) {
    return { error: "Invalid request body." };
  }

  const name = requireText(record, "name", 120, "name is required.");
  if (typeof name !== "string") {
    return name;
  }

  const workEmail = requireText(
    record,
    "workEmail",
    160,
    "workEmail is required."
  );
  if (typeof workEmail !== "string") {
    return workEmail;
  }
  if (!EMAIL_PATTERN.test(workEmail)) {
    return { error: "workEmail must be a valid email address." };
  }

  const company = requireText(record, "company", 120, "company is required.");
  if (typeof company !== "string") {
    return company;
  }

  const interest = normalizeText(record.interest, 24);
  if (!VALID_INTERESTS.has(interest)) {
    return { error: "interest must be one of hosted, services, or both." };
  }

  const volumeBand = normalizeText(record.volumeBand, 24);
  if (!VALID_VOLUME_BANDS.has(volumeBand)) {
    return {
      error: "volumeBand must be one of lt5k, 5k_50k, gt50k, or unsure.",
    };
  }

  const timeline = normalizeText(record.timeline, 24);
  if (!VALID_TIMELINES.has(timeline)) {
    return {
      error: "timeline must be one of asap, month, quarter, or exploring.",
    };
  }

  const details = requireText(
    record,
    "details",
    2000,
    "details is required."
  );
  if (typeof details !== "string") {
    return details;
  }

  return {
    inquiry: {
      name,
      workEmail: workEmail.toLowerCase(),
      company,
      interest: interest as PricingInquiry["interest"],
      volumeBand: volumeBand as PricingInquiry["volumeBand"],
      timeline: timeline as PricingInquiry["timeline"],
      stack: normalizeText(record.stack, 240),
      details,
      website: normalizeText(record.website, 240),
    },
  };
}

export function buildPricingInquiryForwardPayload(input: {
  inquiry: PricingInquiry;
  meta: PricingInquiryRequestMeta;
}) {
  const { inquiry, meta } = input;

  return {
    source: "gtmship-homepage-pricing",
    submittedAt: meta.submittedAt,
    contact: {
      name: inquiry.name,
      workEmail: inquiry.workEmail,
      company: inquiry.company,
    },
    request: {
      interest: inquiry.interest,
      volumeBand: inquiry.volumeBand,
      timeline: inquiry.timeline,
      stack: inquiry.stack || null,
      details: inquiry.details,
    },
    metadata: {
      origin: meta.origin,
      referer: meta.referer,
      userAgent: meta.userAgent,
      forwardedFor: meta.forwardedFor,
      ip: meta.ip,
    },
  };
}

function headerValue(value: string | undefined, maxLength: number): string | null {
  const normalized = normalizeText(value, maxLength);
  return normalized || null;
}

publicInquiryRoutes.post("/inquiries/pricing", async (req, res) => {
  const parsed = parsePricingInquiry(req.body);
  if (!parsed.inquiry) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  if (parsed.inquiry.website) {
    res.status(202).json({ ok: true });
    return;
  }

  const webhookUrl = process.env.PRICING_INQUIRY_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    res.status(503).json({
      error:
        "Inquiry intake is not configured right now. Please email us instead.",
    });
    return;
  }

  const payload = buildPricingInquiryForwardPayload({
    inquiry: parsed.inquiry,
    meta: {
      submittedAt: new Date().toISOString(),
      origin: headerValue(req.get("origin"), 240),
      referer: headerValue(req.get("referer"), 1000),
      userAgent: headerValue(req.get("user-agent"), 500),
      forwardedFor: headerValue(req.get("x-forwarded-for"), 500),
      ip: headerValue(req.ip, 120),
    },
  });

  const webhookSecret = process.env.PRICING_INQUIRY_WEBHOOK_SECRET?.trim();

  try {
    await axios.post(webhookUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        ...(webhookSecret
          ? { "x-gtmship-inquiry-secret": webhookSecret }
          : {}),
      },
      timeout: 10000,
    });

    res.status(202).json({ ok: true });
  } catch (error) {
    console.error("[pricing-inquiry] Failed to forward inquiry", error);
    res.status(502).json({
      error: "Unable to submit inquiry right now. Please try again shortly.",
    });
  }
});
