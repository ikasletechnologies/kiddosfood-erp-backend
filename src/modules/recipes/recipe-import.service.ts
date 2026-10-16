/**
 * Word recipe import: upload → parse → review (matches suggested) → confirm
 * one recipe at a time. Nothing is saved from a document until a reviewer
 * confirms that recipe; unconfirmed recipes stay pending in the session.
 *
 * A confirmed recipe becomes (or adds a version to) a Recipe Master record
 * plus a Reference Formulation (source IMPORT), mirrored into the recipe BOM
 * exactly like a formulation saved in Production Planning, and is linked to
 * its finished-goods variants. No stock, price or product detail is
 * changed. "As Required" lines are kept on the formulation as unresolved and
 * are never scaled or deducted.
 */
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { FormulationService, FormulationError, convertQty, normalizeUnit } from './formulation.service';
import { RecipeService } from './recipe.service';
import { readDocxParagraphs } from './docx-reader';
import { parseRecipeDocument, ParsedRecipe, titleCase } from './recipe-import.parser';
import { matchMaterial, matchRecipe, normalizeName, suggestProducts, MaterialRef } from './recipe-import.matcher';

export const LEARNED_ALIASES_SETTING = 'RECIPE_IMPORT_LEARNED_ALIASES';
const Decimal = Prisma.Decimal;

export type RecipeImportState = 'PENDING' | 'IMPORTED' | 'UNCHANGED' | 'SKIPPED';
interface RecipeStatus { state: RecipeImportState; recipeId?: string; formulationId?: string; version?: number; at?: string; by?: string | null; message?: string }

export interface IngredientDecision {
  index: number;
  action: 'MAP' | 'CREATE' | 'UNRESOLVED';
  inventoryItemId?: string;
  newMaterial?: { name: string; unit: string };
  /** Reviewer-confirmed quantity/unit (defaults to the document's). */
  quantity?: number | null;
  unit?: string | null;
  reason?: string;
}

export interface RecipeDecision {
  mode: 'CREATE' | 'NEW_VERSION';
  existingRecipeId?: string;
  name: string;
  category: string;
  instructions?: string;
  outputIndex: number;
  /** Required when the document lists more than one output stage. */
  stageConfirmed?: boolean;
  /** Reviewer-confirmed reference output (defaults to the chosen stage's). */
  yieldQty?: number;
  yieldUnit?: string;
  ingredients: IngredientDecision[];
  productIds?: string[];
}

export class ImportError extends Error {
  status = 400;
}

/** Learned aliases setting: { normalised source name: inventoryItemId }. */
function parseLearned(value: string | undefined): Record<string, string> {
  try {
    const v = value ? JSON.parse(value) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const QTY_UNITS = new Set(['MG', 'G', 'KG', 'ML', 'L', 'PCS']);

/** Reference output stored per KG / L (ingredients stay as written). */
function storedYield(qty: number, unit: string): { qty: number; unit: string } {
  const u = normalizeUnit(unit);
  if (u === 'G' || u === 'MG') return { qty: convertQty(qty, u, 'KG').toNumber(), unit: 'KG' };
  if (u === 'ML') return { qty: convertQty(qty, u, 'L').toNumber(), unit: 'L' };
  return { qty, unit: u };
}

export class RecipeImportService {
  // ── Sessions ───────────────────────────────────────────────────────────
  /** Parses an uploaded .docx (nothing saved but the review session). */
  static async upload(input: { fileName?: string; contentBase64?: string }, userId?: string) {
    const fileName = String(input.fileName || 'recipes.docx').slice(0, 200);
    if (!/\.docx$/i.test(fileName)) throw new ImportError('Upload a Word .docx file.');
    if (typeof input.contentBase64 !== 'string' || !input.contentBase64) throw new ImportError('The uploaded file is empty.');
    const file = Buffer.from(input.contentBase64.replace(/^data:[^,]*,/, ''), 'base64');
    const parsed = parseRecipeDocument(readDocxParagraphs(file));
    if (parsed.length === 0) throw new ImportError('No recipes were found in this document. Recipe titles must be list items (bullets).');
    const fileHash = createHash('sha256').update(file).digest('hex');

    // Same file again: resume its session (statuses kept), never a second one.
    const existing = await prisma.recipeImportSession.findUnique({ where: { fileHash } });
    const session = existing ?? await prisma.recipeImportSession.create({
      data: {
        fileName,
        fileHash,
        parsed: parsed as any,
        status: Object.fromEntries(parsed.map((r) => [r.key, { state: 'PENDING' }])) as any,
        createdBy: userId ?? null,
      },
    });
    return { ...(await this.review(session.id)), resumed: !!existing };
  }

  static async listSessions() {
    const sessions = await prisma.recipeImportSession.findMany({ orderBy: { updatedAt: 'desc' }, take: 20 });
    return sessions.map((s) => {
      const status = (s.status || {}) as unknown as Record<string, RecipeStatus>;
      const parsed = s.parsed as unknown as ParsedRecipe[];
      const titleByKey = new Map(parsed.map((recipe) => [recipe.key, recipe.title]));
      const states = Object.values(status).map((x) => x.state);
      return {
        id: s.id, fileName: s.fileName, createdAt: s.createdAt, updatedAt: s.updatedAt,
        total: states.length,
        imported: states.filter((x) => x === 'IMPORTED' || x === 'UNCHANGED').length,
        skipped: states.filter((x) => x === 'SKIPPED').length,
        pending: states.filter((x) => x === 'PENDING').length,
        // The session status already owns the durable Recipe id assigned by
        // confirm(). Expose that relationship so Recipe Master can show
        // import history without filename/title guessing or duplicate data.
        recipes: Object.entries(status)
          .filter(([, item]) => !!item.recipeId)
          .map(([key, item]) => ({
            key,
            recipeId: item.recipeId!,
            title: titleByKey.get(key) || null,
            state: item.state,
            importedAt: item.at || s.updatedAt,
            version: item.version || null,
          })),
      };
    });
  }

  /** The review: every recipe with suggested matches, flags and its state. */
  static async review(sessionId: string) {
    const session = await prisma.recipeImportSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new ImportError('Import session not found.');
    const parsed = session.parsed as unknown as ParsedRecipe[];
    const status = session.status as unknown as Record<string, RecipeStatus>;
    const { materials, products, recipes, learned } = await this.loadReferenceData();

    const items = parsed.map((r) => {
      const existing = matchRecipe(r.title, recipes).map((x) => ({
        id: x.id, name: x.name, category: x.category, productionCount: x._count.productions,
        activeFormulation: x.formulations[0] ? {
          id: x.formulations[0].id, version: x.formulations[0].version, yieldQty: x.formulations[0].yieldQty, yieldUnit: x.formulations[0].yieldUnit,
          source: x.formulations[0].source, outputStage: x.formulations[0].outputStage,
          items: x.formulations[0].items.map((i) => ({ inventoryItemId: i.inventoryItemId, name: i.inventoryItem.name, quantity: i.quantity, unit: i.unit })),
        } : null,
      }));
      const linkedTo = (recipeId: string | null | undefined) => recipes.find((x) => x.id === recipeId)?.name ?? null;
      return {
        ...r,
        status: status[r.key] ?? { state: 'PENDING' },
        defaultOutputIndex: Math.max(0, r.outputs.length - 1),
        ingredients: r.ingredients.map((ing, index) => ({ ...ing, index, match: matchMaterial(ing.sourceName, materials, learned) })),
        existingRecipes: existing,
        products: suggestProducts(r.title, r.category, products).map((p) => ({ ...p, linkedRecipeName: linkedTo(p.linkedRecipeId) })),
      };
    });

    const count = (s: RecipeImportState) => items.filter((i) => i.status.state === s).length;
    return {
      session: { id: session.id, fileName: session.fileName, createdAt: session.createdAt, updatedAt: session.updatedAt },
      summary: {
        recipes: items.length,
        pending: count('PENDING'),
        imported: count('IMPORTED'),
        unchanged: count('UNCHANGED'),
        skipped: count('SKIPPED'),
        ingredientLines: items.reduce((s, r) => s + r.ingredients.length, 0),
        unmatchedLines: items.reduce((s, r) => s + r.ingredients.filter((i) => !i.match.inventoryItemId && !i.issues.includes('AS_REQUIRED')).length, 0),
        flaggedLines: items.reduce((s, r) => s + r.ingredients.filter((i) => i.issues.length > 0).length, 0),
      },
      recipes: items,
      materials: materials.map((m) => ({ id: m.id, name: m.name, unit: m.unit, sku: m.sku })),
    };
  }

  private static async loadReferenceData() {
    const [materials, products, recipes, learnedRaw] = await Promise.all([
      prisma.inventoryItem.findMany({
        where: { isActive: true, category: { notIn: ['FINISHED_GOOD'] } },
        select: { id: true, name: true, unit: true, sku: true, category: true },
        orderBy: { name: 'asc' },
      }),
      prisma.product.findMany({
        where: { isActive: true },
        select: { id: true, name: true, sku: true, category: true, basePrice: true, recipeLink: { select: { recipeId: true } } },
      }),
      prisma.recipe.findMany({
        select: {
          id: true, name: true, category: true, _count: { select: { productions: true } },
          formulations: { where: { isActive: true }, take: 1, include: { items: { include: { inventoryItem: { select: { name: true } } }, orderBy: { sortOrder: 'asc' } } } },
        },
      }),
      prisma.systemSetting.findUnique({ where: { key: LEARNED_ALIASES_SETTING } }),
    ]);
    const learned = parseLearned(learnedRaw?.value);
    return {
      materials: materials as MaterialRef[],
      products: products.map((p) => ({ id: p.id, name: p.name, sku: p.sku, category: p.category, basePrice: p.basePrice, linkedRecipeId: p.recipeLink?.recipeId ?? null })),
      recipes,
      learned,
    };
  }

  static async skip(sessionId: string, key: string, skip: boolean, userId?: string) {
    return prisma.$transaction(async (tx) => {
      const session = await this.lockSession(tx, sessionId);
      const status = session.status as unknown as Record<string, RecipeStatus>;
      const current = status[key];
      if (!current) throw new ImportError('Recipe not found in this import.');
      if (current.state === 'IMPORTED' || current.state === 'UNCHANGED') throw new ImportError('This recipe has already been imported.');
      status[key] = skip ? { state: 'SKIPPED', at: new Date().toISOString(), by: userId ?? null } : { state: 'PENDING' };
      await tx.recipeImportSession.update({ where: { id: sessionId }, data: { status: status as any } });
      return status[key];
    });
  }

  private static async lockSession(tx: any, sessionId: string) {
    await tx.$queryRaw`SELECT id FROM "RecipeImportSession" WHERE id = ${sessionId} FOR UPDATE`;
    const session = await tx.recipeImportSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new ImportError('Import session not found.');
    return session;
  }

  // ── Confirm one recipe ────────────────────────────────────────────────
  static async confirm(sessionId: string, key: string, decision: RecipeDecision, userId?: string) {
    const session = await prisma.recipeImportSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new ImportError('Import session not found.');
    const parsed = (session.parsed as unknown as ParsedRecipe[]).find((r) => r.key === key);
    if (!parsed) throw new ImportError('Recipe not found in this import.');
    const plan = await this.validate(parsed, decision);

    // New raw materials are created first, through the normal Raw Material
    // Master path (no stock). An existing material with the same name is
    // reused instead, so a repeat never creates a duplicate.
    const created: Array<{ id: string; name: string; reused: boolean }> = [];
    for (const line of plan.lines.filter((l) => l.action === 'CREATE')) {
      const name = line.newMaterial!.name;
      const same = await prisma.inventoryItem.findMany({ where: { isActive: true, category: { notIn: ['FINISHED_GOOD'] } }, select: { id: true, name: true } });
      const match = same.find((m) => normalizeName(m.name) === normalizeName(name));
      if (match) {
        line.inventoryItemId = match.id;
        created.push({ id: match.id, name: match.name, reused: true });
      } else {
        const item = await InventoryService.createItem({ name, unit: line.newMaterial!.unit, category: 'RAW_MATERIAL', userId });
        line.inventoryItemId = item.id;
        created.push({ id: item.id, name: item.name, reused: false });
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const locked = await this.lockSession(tx, sessionId);
      const status = locked.status as unknown as Record<string, RecipeStatus>;
      const state = status[key]?.state ?? 'PENDING';
      if (state === 'IMPORTED' || state === 'UNCHANGED') throw new ImportError('This recipe has already been imported from this document.');

      // Every mapped material must exist and be a non-finished-goods item.
      const ids = Array.from(new Set(plan.lines.filter((l) => l.action !== 'UNRESOLVED').map((l) => l.inventoryItemId!)));
      const mats = await tx.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, unit: true, category: true, isActive: true } });
      for (const l of plan.lines.filter((x) => x.action !== 'UNRESOLVED')) {
        const m = mats.find((x) => x.id === l.inventoryItemId);
        if (!m || !m.isActive || m.category === 'FINISHED_GOOD') throw new ImportError(`"${l.sourceName}": choose an active raw material.`);
        try { convertQty(1, l.unit!, m.unit); } catch {
          throw new ImportError(`"${l.sourceName}" is ${l.unit}, but "${m.name}" is stocked in ${m.unit}. Choose a material stocked in a compatible unit.`);
        }
      }

      // Two lines for the same material (e.g. again under "Tempering:") are added together.
      const items: Array<{ inventoryItemId: string; quantity: number; unit: string; sourceName: string; sourceText: string }> = [];
      for (const l of plan.lines.filter((x) => x.action !== 'UNRESOLVED')) {
        const prev = items.find((i) => i.inventoryItemId === l.inventoryItemId);
        if (prev) {
          prev.quantity = new Decimal(prev.quantity).plus(convertQty(l.quantity!, l.unit!, prev.unit)).toNumber();
          prev.sourceName = prev.sourceName === l.sourceName ? prev.sourceName : `${prev.sourceName} + ${l.sourceName}`;
          prev.sourceText = `${prev.sourceText} + ${l.sourceText}`;
        } else {
          items.push({ inventoryItemId: l.inventoryItemId!, quantity: l.quantity!, unit: normalizeUnit(l.unit!), sourceName: l.sourceName, sourceText: l.sourceText });
        }
      }
      const unresolved = plan.lines.filter((l) => l.action === 'UNRESOLVED').map((l) => ({
        sourceName: l.sourceName, sourceText: l.sourceText, reason: l.reason, ...(l.inventoryItemId ? { suggestedMaterialId: l.inventoryItemId } : {}),
      }));

      // Recipe: new, or a new formulation version of an existing one.
      let recipeId: string;
      if (decision.mode === 'CREATE') {
        const clash = (await tx.recipe.findMany({ select: { id: true, name: true } })).find((r) => normalizeName(r.name) === normalizeName(plan.name));
        if (clash) throw new ImportError(`A recipe named "${clash.name}" already exists. Choose "Update existing recipe" to add a new formulation version instead.`);
        await tx.recipeCategory.upsert({ where: { name: plan.category }, update: {}, create: { name: plan.category } });
        let n = (await tx.recipe.count()) + 1;
        let recipeCode = `RCP-${String(n).padStart(4, '0')}`;
        while (await tx.recipe.findUnique({ where: { recipeCode }, select: { id: true } })) recipeCode = `RCP-${String(++n).padStart(4, '0')}`;
        const recipe = await tx.recipe.create({ data: { name: plan.name, category: plan.category, instructions: plan.instructions, recipeCode } });
        recipeId = recipe.id;
      } else {
        await tx.$queryRaw`SELECT id FROM "Recipe" WHERE id = ${decision.existingRecipeId} FOR UPDATE`;
        const recipe = await tx.recipe.findUnique({ where: { id: decision.existingRecipeId! }, include: { _count: { select: { productions: true } } } });
        if (!recipe) throw new ImportError('The recipe to update no longer exists.');
        if (recipe._count.productions > 0 && normalizeUnit(recipe.yieldUnit) !== plan.yield.unit) {
          throw new ImportError(`"${recipe.name}" has already been produced in ${recipe.yieldUnit}; its reference output must stay in ${recipe.yieldUnit}.`);
        }
        recipeId = recipe.id;
      }

      // Same formulation as the active one → nothing new (repeat import).
      const active = await FormulationService.getActive(tx, recipeId);
      const same = active && this.sameFormulation(active, plan.yield, items);
      let formulation = active;
      if (!same) {
        await RecipeService.syncIngredients(tx, recipeId, items.map((i) => i.inventoryItemId));
        const last = await tx.recipeFormulation.findFirst({ where: { recipeId }, orderBy: { version: 'desc' }, select: { version: true } });
        await tx.recipeFormulation.updateMany({ where: { recipeId, isActive: true }, data: { isActive: false } });
        formulation = await tx.recipeFormulation.create({
          data: {
            recipeId,
            version: (last?.version || 0) + 1,
            yieldQty: plan.yield.qty,
            yieldUnit: plan.yield.unit,
            notes: parsed.notes.join('\n') || null,
            source: 'IMPORT',
            isActive: true,
            createdBy: userId ?? null,
            outputStage: plan.output.stage,
            outputStages: parsed.outputs.map((o) => ({ stage: o.stage, stageText: o.stageText, qty: o.quantity, qtyText: o.qtyText, unit: o.unit, note: o.note, text: o.sourceText })) as any,
            sourceReference: { document: session.fileName, fileHash: session.fileHash, importSessionId: session.id, recipeKey: key, title: parsed.title, section: parsed.category, importedAt: new Date().toISOString() } as any,
            unresolvedItems: unresolved.length ? (unresolved as any) : undefined,
            items: { create: items.map((i, idx) => ({ ...i, sortOrder: idx })) },
          },
          include: { items: { include: { inventoryItem: true }, orderBy: { sortOrder: 'asc' } } },
        });
        await FormulationService.mirrorToLegacyBom(tx, recipeId, formulation!);
      }

      // Finished-goods variants: linked, never edited.
      const productIds = Array.from(new Set(decision.productIds || []));
      if (productIds.length) {
        const prods = await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, sku: true, recipeLink: { select: { recipeId: true, recipe: { select: { name: true } } } } } });
        for (const id of productIds) {
          const p = prods.find((x) => x.id === id);
          if (!p) throw new ImportError('A selected finished product no longer exists.');
          if (p.recipeLink && p.recipeLink.recipeId !== recipeId) throw new ImportError(`${p.name} (${p.sku}) is already linked to recipe "${p.recipeLink.recipe.name}".`);
        }
        const toLink = prods.filter((p) => !p.recipeLink).map((p) => ({ recipeId, productId: p.id, createdBy: userId ?? null }));
        if (toLink.length) await tx.recipeProduct.createMany({ data: toLink });
      }

      // Remember reviewed mappings so the next recipe/import matches them.
      const learnedRow = await tx.systemSetting.findUnique({ where: { key: LEARNED_ALIASES_SETTING } });
      const learned = parseLearned(learnedRow?.value);
      let changed = false;
      for (const l of plan.lines.filter((x) => x.action !== 'UNRESOLVED')) {
        const k = normalizeName(l.sourceName);
        if (k && learned[k] !== l.inventoryItemId) { learned[k] = l.inventoryItemId!; changed = true; }
      }
      if (changed) {
        await tx.systemSetting.upsert({
          where: { key: LEARNED_ALIASES_SETTING },
          update: { value: JSON.stringify(learned) },
          create: { key: LEARNED_ALIASES_SETTING, value: JSON.stringify(learned), group: 'PRODUCTION', description: 'Recipe import: source ingredient name → raw material, learned from reviews' },
        });
      }

      const newState: RecipeStatus = {
        state: same ? 'UNCHANGED' : 'IMPORTED', recipeId, formulationId: formulation!.id, version: formulation!.version,
        at: new Date().toISOString(), by: userId ?? null,
        message: same ? `Formulation v${formulation!.version} already matches the document; nothing new saved.` : undefined,
      };
      status[key] = newState;
      await tx.recipeImportSession.update({ where: { id: sessionId }, data: { status: status as any } });
      await tx.auditLog.create({
        data: {
          module: 'RECIPE', action: 'IMPORT_CONFIRM', recordId: recipeId, performedBy: userId || 'SYSTEM',
          newValue: {
            document: session.fileName, recipeKey: key, title: parsed.title, mode: decision.mode, result: newState.state,
            formulationVersion: formulation!.version, outputStage: plan.output.stage, yield: plan.yield,
            edits: plan.edits, unresolved, productIds, createdMaterials: created,
          } as any,
        },
      });
      return { status: newState, recipeId, formulationId: formulation!.id, version: formulation!.version };
    }, { timeout: 30000 });

    return { ...result, createdMaterials: created };
  }

  /** Server-side checks of a reviewer decision against the parsed recipe. */
  private static async validate(parsed: ParsedRecipe, d: RecipeDecision) {
    const name = String(d?.name ?? '').trim().replace(/\s+/g, ' ');
    const category = titleCase(String(d?.category ?? '').trim().replace(/\s+/g, ' '));
    if (!name) throw new ImportError('Recipe name is required.');
    if (!category) throw new ImportError('Category is required.');
    if (d.mode !== 'CREATE' && d.mode !== 'NEW_VERSION') throw new ImportError('Choose whether to create a new recipe or update an existing one.');
    if (d.mode === 'NEW_VERSION' && !d.existingRecipeId) throw new ImportError('Choose the existing recipe to update.');

    // Reference output: the chosen stage (confirmed when there are several).
    const output = parsed.outputs[d.outputIndex];
    if (!output) throw new ImportError(parsed.outputs.length ? 'Choose the output stage the reference yield refers to.' : 'This recipe has no output in the document; enter the reference output.');
    if (parsed.outputs.length > 1 && !d.stageConfirmed) {
      throw new ImportError(`The document lists ${parsed.outputs.length} outputs (${parsed.outputs.map((o) => o.stage).join(', ')}). Confirm which stage production targets.`);
    }
    const yieldQty = Number(d.yieldQty ?? output.quantity);
    const yieldUnitRaw = d.yieldUnit ?? output.unit;
    if (!Number.isFinite(yieldQty) || yieldQty <= 0) throw new ImportError('Reference output must be a number greater than zero.');
    if (!yieldUnitRaw) throw new ImportError(`The output "${output.sourceText}" has no unit. Enter it before importing.`);
    let yieldInfo: { qty: number; unit: string };
    try { yieldInfo = storedYield(yieldQty, yieldUnitRaw); } catch (e: any) { throw new ImportError(`Reference output: ${e.message}`); }

    const edits: Array<{ line: string; from: string; to: string }> = [];
    if (output.quantity !== yieldQty || (output.unit && normalizeUnit(output.unit) !== normalizeUnit(yieldUnitRaw))) {
      edits.push({ line: output.sourceText, from: `${output.qtyText ?? '—'} ${output.unit ?? ''}`.trim(), to: `${yieldQty} ${normalizeUnit(yieldUnitRaw)}` });
    }

    const decisions = Array.isArray(d.ingredients) ? d.ingredients : [];
    const lines = parsed.ingredients.map((ing, index) => {
      const dec = decisions.find((x) => x.index === index);
      if (!dec) throw new ImportError(`"${ing.sourceName}": choose a material, create one, or leave it unresolved.`);
      if (dec.action === 'UNRESOLVED') {
        return {
          action: 'UNRESOLVED' as const, sourceName: ing.sourceName, sourceText: ing.sourceText,
          reason: ing.issues.find((i) => i !== 'REPEATED') ?? (String(dec.reason || '').trim().slice(0, 200) || 'EXCLUDED_BY_REVIEWER'),
          inventoryItemId: dec.inventoryItemId || undefined, quantity: null as number | null, unit: null as string | null, newMaterial: undefined as any,
        };
      }
      if (dec.action !== 'MAP' && dec.action !== 'CREATE') throw new ImportError(`"${ing.sourceName}": unknown action.`);
      // A quantity comes from the document or is entered by the reviewer —
      // never filled in automatically ("As Required", ranges, missing units).
      const quantity = Number(dec.quantity ?? ing.quantity);
      const unitRaw = dec.unit ?? ing.unit;
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new ImportError(`"${ing.sourceName}" (${ing.sourceText}) has no usable quantity. Enter an approved quantity or leave it unresolved.`);
      }
      if (!unitRaw) throw new ImportError(`"${ing.sourceName}" (${ing.sourceText}) has no unit. Enter the unit or leave it unresolved.`);
      const unit = String(unitRaw).toUpperCase();
      if (!QTY_UNITS.has(unit)) throw new ImportError(`"${ing.sourceName}": unit must be one of ${[...QTY_UNITS].join(', ')}.`);
      if (ing.quantity !== quantity || (ing.unit || '') !== unit) {
        edits.push({ line: ing.sourceText, from: `${ing.qtyText ?? '—'} ${ing.unit ?? ''}`.trim(), to: `${quantity} ${unit}` });
      }
      if (dec.action === 'MAP' && !dec.inventoryItemId) throw new ImportError(`"${ing.sourceName}": choose the raw material.`);
      let newMaterial: { name: string; unit: string } | undefined;
      if (dec.action === 'CREATE') {
        const mName = String(dec.newMaterial?.name ?? ing.sourceName).trim().replace(/\s+/g, ' ');
        const mUnit = String(dec.newMaterial?.unit || (unit === 'ML' || unit === 'L' ? 'L' : unit === 'PCS' ? 'pcs' : 'kg'));
        if (!mName) throw new ImportError(`"${ing.sourceName}": enter a name for the new raw material.`);
        try { convertQty(1, unit, mUnit); } catch { throw new ImportError(`"${ing.sourceName}": a material stocked in ${mUnit} can't take ${unit}.`); }
        newMaterial = { name: mName, unit: mUnit };
      }
      return { action: dec.action, sourceName: ing.sourceName, sourceText: ing.sourceText, quantity, unit, inventoryItemId: dec.inventoryItemId as string | undefined, newMaterial, reason: undefined as string | undefined };
    });
    if (!lines.some((l) => l.action !== 'UNRESOLVED')) throw new ImportError('At least one ingredient must have a material and quantity.');

    const instructions = String(d.instructions ?? parsed.notes.join('\n')).trim() || null;
    return { name, category, instructions, output, yield: yieldInfo, lines, edits };
  }

  /** Active formulation already says the same thing (yield and every line). */
  private static sameFormulation(
    active: { yieldQty: number; yieldUnit: string; items: Array<{ inventoryItemId: string; quantity: number; unit: string }> },
    y: { qty: number; unit: string },
    items: Array<{ inventoryItemId: string; quantity: number; unit: string }>,
  ): boolean {
    const eq = (a: Prisma.Decimal, b: number) => a.minus(b).abs().lte(1e-9);
    try {
      if (!eq(convertQty(active.yieldQty, active.yieldUnit, y.unit), y.qty)) return false;
      if (active.items.length !== items.length) return false;
      return items.every((i) => {
        const a = active.items.find((x) => x.inventoryItemId === i.inventoryItemId);
        return !!a && eq(convertQty(a.quantity, a.unit, i.unit), i.quantity);
      });
    } catch {
      return false;
    }
  }
}

export { FormulationError };
