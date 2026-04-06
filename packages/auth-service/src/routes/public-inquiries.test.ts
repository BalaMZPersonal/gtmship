import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPricingInquiryForwardPayload,
  parsePricingInquiry,
} from "./public-inquiries.js";

test("parsePricingInquiry validates and normalizes a valid payload", () => {
  const result = parsePricingInquiry({
    name: "  Bala  ",
    workEmail: "  Bala@Example.com ",
    company: " GTMship ",
    interest: "hosted",
    volumeBand: "5k_50k",
    timeline: "month",
    stack: " HubSpot, Salesforce, Slack ",
    details: " Need lead routing and enrichment automated. ",
    website: "   ",
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(result.inquiry, {
    name: "Bala",
    workEmail: "bala@example.com",
    company: "GTMship",
    interest: "hosted",
    volumeBand: "5k_50k",
    timeline: "month",
    stack: "HubSpot, Salesforce, Slack",
    details: "Need lead routing and enrichment automated.",
    website: "",
  });
});

test("parsePricingInquiry rejects missing required values and invalid enums", () => {
  const missingDetails = parsePricingInquiry({
    name: "Bala",
    workEmail: "bala@example.com",
    company: "GTMship",
    interest: "hosted",
    volumeBand: "lt5k",
    timeline: "month",
    details: "   ",
  });

  assert.deepEqual(missingDetails, { error: "details is required." });

  const invalidInterest = parsePricingInquiry({
    name: "Bala",
    workEmail: "bala@example.com",
    company: "GTMship",
    interest: "support",
    volumeBand: "lt5k",
    timeline: "month",
    details: "Need help.",
  });

  assert.deepEqual(invalidInterest, {
    error: "interest must be one of hosted, services, or both.",
  });
});

test("buildPricingInquiryForwardPayload shapes the webhook body with metadata", () => {
  const payload = buildPricingInquiryForwardPayload({
    inquiry: {
      name: "Bala",
      workEmail: "bala@example.com",
      company: "GTMship",
      interest: "both",
      volumeBand: "unsure",
      timeline: "exploring",
      stack: "",
      details: "We want managed hosting and build help.",
      website: "",
    },
    meta: {
      submittedAt: "2026-04-06T09:00:00.000Z",
      origin: "https://www.gtmship.com",
      referer: "https://www.gtmship.com/#pricing",
      userAgent: "Mozilla/5.0",
      forwardedFor: "127.0.0.1",
      ip: "::1",
    },
  });

  assert.deepEqual(payload, {
    source: "gtmship-homepage-pricing",
    submittedAt: "2026-04-06T09:00:00.000Z",
    contact: {
      name: "Bala",
      workEmail: "bala@example.com",
      company: "GTMship",
    },
    request: {
      interest: "both",
      volumeBand: "unsure",
      timeline: "exploring",
      stack: null,
      details: "We want managed hosting and build help.",
    },
    metadata: {
      origin: "https://www.gtmship.com",
      referer: "https://www.gtmship.com/#pricing",
      userAgent: "Mozilla/5.0",
      forwardedFor: "127.0.0.1",
      ip: "::1",
    },
  });
});
