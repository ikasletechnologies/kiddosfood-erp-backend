import { randomUUID } from 'crypto';
import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error.middleware';
import { TokenPayload } from '../../lib/jwt.util';
import { encryptField, decryptField } from '../../lib/field-crypto';
import { DOCUMENT_CATEGORIES, DOCUMENT_ENTITY, MAX_DOCUMENT_BYTES, validateDocument } from './franchise-document.validation';

const metadata = {id:true,franchiseId:true,category:true,originalFileName:true,mimeType:true,fileSize:true,familyId:true,version:true,status:true,visibility:true,uploadedBy:true,uploadedByName:true,uploadedAt:true,updatedAt:true,issueDate:true,expiryDate:true,notes:true} as const;
export class FranchiseDocumentService {
  static scope(user:TokenPayload,id:string,write=false){
    if(!user || (user.role!=='SUPER_ADMIN' && (write || user.role!=='FRANCHISE_ADMIN' || !user.franchiseId || user.franchiseId!==id)))throw new AppError('Forbidden',403);
  }
  static async audit(db:any,user:TokenPayload,action:string,id:string,franchiseId:string){
    // IDs only: no filename, notes, identifiers or file contents in audit details.
    await db.auditLog.create({data:{module:'FRANCHISE_DOCUMENTS',action,recordId:id,performedBy:user.userId,newValue:{franchiseId}}});
  }
  static async list(user:TokenPayload,franchiseId:string,history=false){
    this.scope(user,franchiseId);if(history && user.role!=='SUPER_ADMIN')throw new AppError('Forbidden',403);
    if(!await prisma.franchise.findUnique({where:{id:franchiseId},select:{id:true}}))throw new AppError('Franchise not found',404);
    const documents=await prisma.franchiseDocument.findMany({where:{franchiseId,...(history?{}:{status:'ACTIVE'}),...(user.role==='SUPER_ADMIN'?{}:{visibility:'SHARED'})},select:metadata,orderBy:[{uploadedAt:'desc'},{version:'desc'}]});
    return {categories:DOCUMENT_CATEGORIES,maxFileBytes:MAX_DOCUMENT_BYTES,documents};
  }
  static dates(body:any){
    const result:any={};
    for(const key of ['issueDate','expiryDate'])if(Object.prototype.hasOwnProperty.call(body,key)){
      const value=body[key];if(value===null||value==='')result[key]=null;
      else {if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(new Date(value).getTime()))throw new AppError('Invalid document date',422);result[key]=new Date(value+'T00:00:00.000Z');if(result[key].toISOString().slice(0,10)!==value)throw new AppError('Invalid document date',422);}
    }
    if(Object.prototype.hasOwnProperty.call(body,'notes')){
      if(body.notes!==null && (typeof body.notes!=='string'||body.notes.length>2000))throw new AppError('Notes must be at most 2000 characters',422);
      result.notes=body.notes || null;
    }
    if(Object.prototype.hasOwnProperty.call(body,'visibility')){
      if(!['INTERNAL','SHARED'].includes(body.visibility))throw new AppError('Invalid visibility',422);result.visibility=body.visibility;
    }
    return result;
  }
  static async upload(user:TokenPayload,franchiseId:string,body:any){
    this.scope(user,franchiseId,true);
    const category=DOCUMENT_CATEGORIES.find(c=>c.id===body.category);if(!category)throw new AppError('Invalid document category',422);
    const file=validateDocument(body),extra=this.dates(body);
    // Reuse the existing AES-GCM key management; fail closed if unavailable.
    const encrypted=Buffer.from(encryptField(file.data.toString('base64')),'utf8');
    return prisma.$transaction(async tx=>{
      const branch=await tx.$queryRaw<Array<{id:string}>>`SELECT "id" FROM "Franchise" WHERE "id" = ${franchiseId} FOR UPDATE`;
      if(!branch.length)throw new AppError('Franchise not found',404);
      const previous=body.replaceId?await tx.franchiseDocument.findFirst({where:{id:String(body.replaceId),franchiseId,category:category.id,status:'ACTIVE'}}):null;
      if(body.replaceId&&!previous)throw new AppError('Active document not found',404);
      if(!previous && !('multiple' in category) && await tx.franchiseDocument.findFirst({where:{franchiseId,category:category.id,status:'ACTIVE'},select:{id:true}}))throw new AppError('A document already exists. Use Replace.',409);
      const uploader=await tx.user.findUnique({where:{id:user.userId},select:{fullName:true}});
      const stored=await tx.attachment.create({data:{entityType:DOCUMENT_ENTITY,entityId:franchiseId,franchiseId,kind:'DOCUMENT',fileName:randomUUID()+'.enc',mimeType:'application/octet-stream',size:encrypted.length,data:encrypted,uploadedBy:user.userId},select:{id:true}});
      if(previous)await tx.franchiseDocument.update({where:{id:previous.id},data:{status:'HISTORICAL'}});
      const doc=await tx.franchiseDocument.create({data:{franchiseId,category:category.id,originalFileName:file.fileName,storageKey:stored.id,mimeType:file.mimeType,fileSize:file.size,familyId:previous?.familyId || randomUUID(),version:previous?previous.version+1:1,status:'ACTIVE',visibility:'INTERNAL',uploadedBy:user.userId,uploadedByName:uploader?.fullName || 'Super Admin',...extra},select:metadata});
      await this.audit(tx,user,previous?'REPLACE':'UPLOAD',doc.id,franchiseId);return doc;
    });
  }
  static async update(user:TokenPayload,franchiseId:string,id:string,body:any){
    this.scope(user,franchiseId,true);const extra=this.dates(body);
    return prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT "id" FROM "Franchise" WHERE "id" = ${franchiseId} FOR UPDATE`;
      const doc=await tx.franchiseDocument.findFirst({where:{id,franchiseId,status:'ACTIVE'},select:{id:true}});
      if(!doc)throw new AppError('Document not found',404);
      const result=await tx.franchiseDocument.update({where:{id},data:extra,select:metadata});
      await this.audit(tx,user,'UPDATE',id,franchiseId);return result;
    });
  }
  static async archive(user:TokenPayload,franchiseId:string,id:string){
    this.scope(user,franchiseId,true);
    return prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT "id" FROM "Franchise" WHERE "id" = ${franchiseId} FOR UPDATE`;
      const result=await tx.franchiseDocument.updateMany({where:{id,franchiseId,status:'ACTIVE'},data:{status:'ARCHIVED'}});
      if(!result.count)throw new AppError('Active document not found',404);
      await this.audit(tx,user,'ARCHIVE',id,franchiseId);return {success:true};
    });
  }
  static async file(user:TokenPayload,franchiseId:string,id:string,preview:boolean){
    this.scope(user,franchiseId);
    const doc=await prisma.franchiseDocument.findFirst({where:{id,franchiseId,...(user.role==='SUPER_ADMIN'?{}:{status:'ACTIVE',visibility:'SHARED'})},include:{attachment:true}});
    if(!doc)throw new AppError('Document not found',404);
    if(preview && doc.mimeType!=='application/pdf' && !doc.mimeType.startsWith('image/'))throw new AppError('Preview is not supported. Download this document instead.',422);
    const data=Buffer.from(decryptField(Buffer.from(doc.attachment.data).toString('utf8')),'base64');
    await this.audit(prisma,user,preview?'PREVIEW':'DOWNLOAD',id,franchiseId);
    return {data,mimeType:doc.mimeType,fileName:doc.originalFileName};
  }
}

