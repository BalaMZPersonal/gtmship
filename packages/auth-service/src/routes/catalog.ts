import { Router } from "express";
import { getCatalog, searchCatalog, getCatalogProvider, getCatalogCategories } from "../services/catalog.js";

export const catalogRoutes: Router = Router();

// List all catalog integrations
catalogRoutes.get("/", async (req, res) => {
  const query = req.query.q as string | undefined;
  const category = req.query.category as string | undefined;

  let items = query ? await searchCatalog(query) : await getCatalog();

  if (category && category !== "All") {
    items = items.filter((p) => p.category === category);
  }

  const categories = await getCatalogCategories();
  res.json({ items, categories });
});

// Get a single catalog provider by slug
catalogRoutes.get("/:slug", async (req, res) => {
  const provider = await getCatalogProvider(req.params.slug);
  if (!provider) {
    res.status(404).json({ error: "Provider not found in catalog" });
    return;
  }
  res.json(provider);
});
