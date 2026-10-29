import {Request,Response,NextFunction} from 'express';
import {FinishedGoodsLowStockService} from './finished-goods-low-stock';
export class FinishedGoodsLowStockController {
  static async get(_req:Request,res:Response,next:NextFunction){
    try{res.setHeader('Cache-Control','no-store');res.json(await FinishedGoodsLowStockService.get());}catch(error){next(error);}
  }
  static async update(req:Request,res:Response,next:NextFunction){
    try{res.setHeader('Cache-Control','no-store');res.json(await FinishedGoodsLowStockService.set(req.body?.finishedGoodsLowStockThreshold));}catch(error){next(error);}
  }
}

