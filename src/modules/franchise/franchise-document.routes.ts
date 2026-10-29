import { Router,Request,Response,NextFunction } from 'express';
import {AppError} from '../../middleware/error.middleware';
import { authenticate,authorizeRole } from '../../middleware/rbac.middleware';
import { FranchiseDocumentService as Service } from './franchise-document.service';
const router=Router({mergeParams:true});
const safeError=(error:unknown)=>error instanceof AppError?error:new AppError('Document operation failed. Contact the system administrator.',500);
router.use(authenticate,authorizeRole(['SUPER_ADMIN','FRANCHISE_ADMIN']));
const handle=(fn:(req:Request,user:any)=>Promise<any>)=>async(req:Request,res:Response,next:NextFunction)=>{
  try{res.setHeader('Cache-Control','private, no-store');res.json(await fn(req,(req as any).user));}catch(error){next(safeError(error));}
};
router.get('/',handle((req,user)=>Service.list(user,req.params.id,req.query.history==='true')));
router.post('/',handle((req,user)=>Service.upload(user,req.params.id,req.body || {})));
router.patch('/:documentId',handle((req,user)=>Service.update(user,req.params.id,req.params.documentId,req.body || {})));
router.delete('/:documentId',handle((req,user)=>Service.archive(user,req.params.id,req.params.documentId)));
router.get('/:documentId/file',async(req:Request,res:Response,next:NextFunction)=>{
  try{
    const preview=req.query.preview==='true',file=await Service.file((req as any).user,req.params.id,req.params.documentId,preview);
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; frame-ancestors 'self'");
    res.setHeader('Content-Type',file.mimeType);
    res.setHeader('Content-Disposition',(preview?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(file.fileName));
    res.setHeader('Content-Length',file.data.length);
    res.end(file.data);
  }catch(error){next(safeError(error));}
});
export default router;

