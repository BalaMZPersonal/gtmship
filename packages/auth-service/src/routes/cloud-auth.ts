import { Router } from "express";
import { prisma } from "../services/db.js";
import { decrypt } from "../services/crypto.js";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

export const cloudAuthRoutes: Router = Router();

const ENCRYPTED_KEYS = ["aws_secret_access_key", "gcp_service_account_key"];

async function getSetting(key: string): Promise<string | null> {
  const setting = await prisma.setting.findUnique({ where: { key } });
  if (!setting) return null;
  return ENCRYPTED_KEYS.includes(key) ? decrypt(setting.value) : setting.value;
}

// Validate cloud credentials
cloudAuthRoutes.post("/validate", async (req, res) => {
  const { provider } = req.body;

  try {
    if (provider === "aws") {
      const accessKeyId = await getSetting("aws_access_key_id");
      const secretAccessKey = await getSetting("aws_secret_access_key");

      if (!accessKeyId || !secretAccessKey) {
        res.json({ valid: false, error: "No AWS credentials configured" });
        return;
      }

      const sts = new STSClient({
        credentials: { accessKeyId, secretAccessKey },
      });
      const identity = await sts.send(new GetCallerIdentityCommand({}));

      res.json({
        valid: true,
        identity: `${identity.Account}/${identity.Arn}`,
      });
    } else if (provider === "gcp") {
      const serviceAccountKeyRaw = await getSetting("gcp_service_account_key");

      if (!serviceAccountKeyRaw) {
        res.json({ valid: false, error: "No GCP credentials configured" });
        return;
      }

      const serviceAccountKey = JSON.parse(serviceAccountKeyRaw);

      if (
        !serviceAccountKey.client_email ||
        !serviceAccountKey.private_key ||
        !serviceAccountKey.project_id
      ) {
        res.json({
          valid: false,
          error: "Service account key missing required fields (client_email, private_key, project_id)",
        });
        return;
      }

      // Make a real API call to verify the credentials work
      const authLib = await import("google-auth-library");
      const jwtClient = new authLib.JWT({
        email: serviceAccountKey.client_email,
        key: serviceAccountKey.private_key,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      await jwtClient.authorize();

      res.json({
        valid: true,
        identity: serviceAccountKey.client_email,
        projectId: serviceAccountKey.project_id,
      });
    } else {
      res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }
  } catch (error) {
    res.json({
      valid: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Get decrypted cloud credentials
cloudAuthRoutes.get("/credentials/:provider", async (req, res) => {
  const { provider } = req.params;

  try {
    if (provider === "aws") {
      const accessKeyId = await getSetting("aws_access_key_id");
      const secretAccessKey = await getSetting("aws_secret_access_key");
      const region = await getSetting("aws_region");

      if (!accessKeyId || !secretAccessKey) {
        res.status(404).json({ error: "AWS credentials not found" });
        return;
      }

      res.json({
        credentials: {
          accessKeyId,
          secretAccessKey,
          region: region || "us-east-1",
        },
      });
    } else if (provider === "gcp") {
      const serviceAccountKeyRaw = await getSetting("gcp_service_account_key");
      const projectId = await getSetting("gcp_project_id");
      const region = await getSetting("gcp_region");

      if (!serviceAccountKeyRaw) {
        res.status(404).json({ error: "GCP credentials not found" });
        return;
      }

      res.json({
        credentials: {
          serviceAccountKey: JSON.parse(serviceAccountKeyRaw),
          projectId: projectId || null,
          region: region || null,
        },
      });
    } else {
      res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }
  } catch (error) {
    res.json({
      valid: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
