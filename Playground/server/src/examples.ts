import { Router, Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";

export const examplesRouter = Router();

const EXAMPLES_DIR = path.resolve(process.env.COMPILER_PATH || "../../compiler", "..", "examples");

const EXAMPLES: Record<string, { name: string; description: string; file: string }> = {
  marketplace: {
    name: "Marketplace",
    description: "Full e-commerce platform with buyers, sellers, listings, orders, reviews, and trade flows.",
    file: "marketplace/shop.marrow",
  },
  inventory: {
    name: "Inventory Platform",
    description: "Multiplayer game backend with players, items, trading, and real-time channels.",
    file: "inventory_platform.marrow",
  },
  delivery: {
    name: "Delivery Platform",
    description: "Delivery service with drivers, orders, routing algorithms, and pipelines.",
    file: "delivery_platform.marrow",
  },
  minimal: {
    name: "Minimal",
    description: "Bare-bones system with one entity and one capability. Good starting point.",
    file: "test_simple.marrow",
  },
};

/**
 * GET /api/examples
 * Returns list of available examples
 */
examplesRouter.get("/", (_req: Request, res: Response) => {
  const list = Object.entries(EXAMPLES).map(([id, ex]) => ({
    id,
    name: ex.name,
    description: ex.description,
  }));
  res.json({ examples: list });
});

/**
 * GET /api/examples/:id
 * Returns the .marrow source for an example
 */
examplesRouter.get("/:id", (req: Request, res: Response) => {
  const example = EXAMPLES[req.params.id];
  if (!example) {
    res.status(404).json({ error: "Example not found" });
    return;
  }

  const filePath = path.join(EXAMPLES_DIR, example.file);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Example file not found on server" });
    return;
  }

  const source = fs.readFileSync(filePath, "utf-8");
  res.json({ id: req.params.id, name: example.name, description: example.description, source });
});
