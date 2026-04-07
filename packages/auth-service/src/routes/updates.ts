import { Router } from "express";
import { getUpdateStatus, snoozeUpdateNotice } from "../services/updates.js";

export const updateRoutes: Router = Router();

updateRoutes.get("/status", async (_req, res) => {
  res.json(await getUpdateStatus());
});

updateRoutes.post("/snooze", async (req, res) => {
  try {
    const version = typeof req.body?.version === "string" ? req.body.version : "";
    const until = typeof req.body?.until === "string" ? req.body.until : "";
    const status = await getUpdateStatus();

    if (!status.latestVersion || version.trim() !== status.latestVersion) {
      res.status(400).json({
        error: "version must match the latest advertised GTMShip release.",
      });
      return;
    }

    res.json(
      await snoozeUpdateNotice({
        version,
        until,
      })
    );
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to snooze the GTMShip update notice.",
    });
  }
});
