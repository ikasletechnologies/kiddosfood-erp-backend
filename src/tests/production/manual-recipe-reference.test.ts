import { test } from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../../lib/prisma';
import { RecipeService } from '../../modules/recipes/recipe.service';
import { FormulationService } from '../../modules/recipes/formulation.service';
import { ProductionCostingService } from '../../modules/production/production-costing.service';
import { DEFAULT_EXPENSE_CATEGORIES } from '../../modules/production/production-costing';

test('manual reference recipe persistence, expenses, scaling and history (always rolled back)', {skip:process.env.KIDDOS_RECIPE_ROLLBACK_TEST !== '1'}, async () => {
  const originalTransaction=prisma.$transaction.bind(prisma);
  const categories=ProductionCostingService.getExpenseCategories;
  const stop=new Error('ROLLBACK_TEST_FIXTURES');
  let fixtureId='';
  ProductionCostingService.getExpenseCategories=async()=>DEFAULT_EXPENSE_CATEGORIES;
  try {
    await assert.rejects(originalTransaction(async tx=>{
      (prisma as any).$transaction=(fn:any)=>fn(tx);
      const stamp=Date.now();
      const mk=(name:string,unit:string)=>tx.inventoryItem.create({data:{name:`Recipe test ${name} ${stamp}`,sku:`RFT-${name}-${stamp}`,unit,category:'RAW_MATERIAL',currentStock:100,minimumStock:0,costPrice:10}});
      const rice=await mk('rice','KG'),dal=await mk('dal','KG'),water=await mk('water','L'),egg=await mk('egg','PCS');
      const expenses=[{category:'MANPOWER',enabled:true,basis:'PER_BATCH',rate:20},{category:'ELECTRICITY',enabled:true,basis:'PER_KG',rate:2}];
      const input={name:`Reference recipe ${stamp}`,category:'Tests',instructions:'Mix',ingredientIds:[rice.id,dal.id],additionalExpenses:expenses,formulation:{yieldQty:1,yieldUnit:'KG',items:[{inventoryItemId:rice.id,quantity:600,unit:'G'},{inventoryItemId:dal.id,quantity:200,unit:'G'}]}};
      const first:any=await RecipeService.saveSimplifiedRecipe(input);
      fixtureId=first.id;
      assert.equal(first.activeFormulation.version,1);assert.equal(first.yieldQty,1);assert.equal(first.yieldUnit,'KG');assert.equal(first.additionalExpenses.find((e:any)=>e.category==='MANPOWER').rate,20);
      const loaded:any=await tx.recipe.findUnique({where:{id:first.id},include:RecipeService.recipeInclude});
      assert.equal(loaded.formulations[0].items[0].quantity,600);
      const scaled=FormulationService.scale(loaded.formulations[0],10000,'G');
      assert.equal(scaled.factor,10);assert.equal(scaled.lines[0].requiredInStockUnit,6);assert.equal(scaled.lines[1].requiredInStockUnit,2);
      assert.equal((await tx.inventoryItem.findUnique({where:{id:rice.id}}))!.currentStock,100);
      const unchanged:any=await RecipeService.saveSimplifiedRecipe({...input,id:first.id,name:'Renamed fixture'});
      assert.equal(unchanged.activeFormulation.id,first.activeFormulation.id,'Metadata save must not create a formulation version');
      await tx.recipeFormulation.update({where:{id:first.activeFormulation.id},data:{notes:'Keep original notes',unresolvedItems:[{sourceName:'Water as required',reason:'AS_REQUIRED'}]}});
      const branch=await tx.franchise.create({data:{name:`Recipe fixture ${stamp}`,location:'Test',ownerName:'Test',contactNum:'0'}});
      const batch=await tx.production.create({data:{recipeId:first.id,quantity:10,productionType:'FINISHED_GOOD',franchiseId:branch.id,status:'COMPLETED',actualYield:9,totalCost:123,formulationId:first.activeFormulation.id,formulationSnapshot:{version:1},expenseSnapshot:{frozen:true}}});
      const updated:any=await RecipeService.saveSimplifiedRecipe({...input,id:first.id,formulation:{...input.formulation,items:[{inventoryItemId:rice.id,quantity:0.5,unit:'KG'},{inventoryItemId:dal.id,quantity:250,unit:'G'}]}});
      assert.equal(updated.activeFormulation.version,2);
      assert.equal(updated.activeFormulation.notes,'Keep original notes');
      assert.deepEqual(updated.activeFormulation.unresolvedItems,[{sourceName:'Water as required',reason:'AS_REQUIRED'}]);
      const historic=await tx.production.findUnique({where:{id:batch.id}});
      assert.equal(historic!.formulationId,first.activeFormulation.id);assert.equal(historic!.totalCost,123);assert.equal(historic!.actualYield,9);assert.deepEqual(historic!.expenseSnapshot,{frozen:true});
      assert.equal(await tx.recipeFormulation.count({where:{recipeId:first.id}}),2);
      const liquid:any=await RecipeService.saveSimplifiedRecipe({name:'Liquid fixture',category:'Tests',ingredientIds:[water.id,egg.id],additionalExpenses:[],formulation:{yieldQty:1,yieldUnit:'L',items:[{inventoryItemId:water.id,quantity:500,unit:'ML'},{inventoryItemId:egg.id,quantity:2,unit:'PCS'}]}});
      const volume=FormulationService.scale(liquid.activeFormulation,2000,'ML');assert.equal(volume.lines[0].requiredInStockUnit,1);assert.equal(volume.lines[1].requiredInStockUnit,4);
      for(const formulation of [{...input.formulation,yieldQty:0},{...input.formulation,yieldUnit:'BUCKET'},{...input.formulation,items:[{inventoryItemId:rice.id,quantity:0,unit:'G'},input.formulation.items[1]]},{...input.formulation,items:[{inventoryItemId:rice.id,quantity:-1,unit:'G'},input.formulation.items[1]]}]) await assert.rejects(RecipeService.saveSimplifiedRecipe({...input,formulation}));
      // Validation fails after recipe/ingredients are written: the outer transaction must roll all of it back.
      await assert.rejects(RecipeService.saveSimplifiedRecipe({...input,name:'Invalid fixture',formulation:{...input.formulation,items:[{inventoryItemId:rice.id,quantity:1,unit:'L'},input.formulation.items[1]]}}),/can't be converted/);
      throw stop;
    }),e=>e===stop);
    assert.equal(await prisma.recipe.findUnique({where:{id:fixtureId}}),null,'All test data must be rolled back');
  } finally {
    (prisma as any).$transaction=originalTransaction;
    ProductionCostingService.getExpenseCategories=categories;
    await prisma.$disconnect();
  }
});
