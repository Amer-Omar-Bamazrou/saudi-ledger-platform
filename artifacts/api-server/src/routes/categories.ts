import { Router } from "express";
import { db } from "@workspace/db";
import { categoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  ListCategoriesResponse,
  CreateCategoryBody,
  CreateCategoryResponse,
} from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(categoriesTable)
      .orderBy(categoriesTable.type, categoriesTable.name);

    const parsed = ListCategoriesResponse.parse(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        nameAr: r.nameAr,
        type: r.type,
        vatApplicable: r.vatApplicable,
        zakatRelevant: r.zakatRelevant,
        description: r.description ?? null,
      }))
    );
    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "listCategories failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  const body = CreateCategoryBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  try {
    const [inserted] = await db
      .insert(categoriesTable)
      .values({
        name: body.data.name,
        nameAr: body.data.nameAr,
        type: body.data.type,
        vatApplicable: body.data.vatApplicable,
        zakatRelevant: body.data.zakatRelevant,
        description: body.data.description ?? null,
      })
      .returning();

    const parsed = CreateCategoryResponse.parse({
      id: inserted.id,
      name: inserted.name,
      nameAr: inserted.nameAr,
      type: inserted.type,
      vatApplicable: inserted.vatApplicable,
      zakatRelevant: inserted.zakatRelevant,
      description: inserted.description ?? null,
    });
    res.status(201).json(parsed);
  } catch (err) {
    req.log.error({ err }, "createCategory failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
