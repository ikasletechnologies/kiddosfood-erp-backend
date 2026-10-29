import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import prisma from '../../lib/prisma';
import {FranchiseController} from '../../modules/franchise/franchise.controller';
import {FranchiseService} from '../../modules/franchise/franchise.service';
import {AuthService} from '../../modules/auth/auth.service';
import {JwtUtil} from '../../lib/jwt.util';
import {authenticate,authorizeRole} from '../../middleware/rbac.middleware';
import {errorHandler} from '../../middleware/error.middleware';
import {MAX_FRANCHISE_PHOTO_BYTES,FRANCHISE_PHOTO_ENTITY,validateFranchisePhoto} from '../../modules/attachments/franchise-photo';
const images:Record<string,string>={"image/png":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAE0lEQVR4AWL62qTwHxkzMaABAAAAAP//jfqQnQAAAAZJREFUAwAI4wpdN0fouwAAAABJRU5ErkJggg==","image/jpeg":"/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAB//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKEAYkp//9k=","image/webp":"UklGRh4CAABXRUJQVlA4WAoAAAAgAAAAAwAAAQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggMAAAABACAJ0BKgQAAgABQCYloAJ0ugH4AfgAA8gA/utkX/2dzaqQ/xCf/YOmDLn+GgAAAA=="};

test('photo formats are verified from actual content, not the supplied MIME or name',()=>{
  for(const [mimeType,dataBase64] of Object.entries(images)) {const result=validateFranchisePhoto({mimeType,dataBase64,fileName:'../../unsafe.name'});assert.equal(result?.mimeType,mimeType);assert.match(result!.fileName,/^[0-9a-f-]{36}\.(jpg|png|webp)$/);}
  for(const input of [{mimeType:'image/png',dataBase64:Buffer.from('<svg onload="alert(1)"/>').toString('base64')},{mimeType:'image/jpeg',dataBase64:images['image/png']},{mimeType:'image/png',dataBase64:'not-base64'},{mimeType:'image/png',dataBase64:Buffer.from([137,80,78,71]).toString('base64')}]) assert.throws(()=>validateFranchisePhoto(input));
  assert.equal(validateFranchisePhoto(undefined),undefined);assert.equal(validateFranchisePhoto(null),null);
});

test('franchise photo API, authentication and transactional lifecycle',{timeout:180000},async t=>{
  const target=new URL(process.env.DATABASE_URL || '');assert.equal(process.env.KIDDOS_PHOTO_TEST_DB,'1');assert.equal(target.hostname,'127.0.0.1');assert.equal(target.pathname,'/kiddos_photo_test');
  let server:any;
  try {
    assert.equal(await prisma.franchise.count(),0,'Requires a fresh disposable database');
    process.env.FIELD_ENCRYPTION_KEY=Buffer.alloc(32,25).toString('hex');
    const superToken=JwtUtil.generateAccessToken({userId:'photo-super-test',role:'SUPER_ADMIN'});
    const app=express();app.use(express.json({limit:'8mb'}));app.use(authenticate,authorizeRole(['SUPER_ADMIN','FRANCHISE_ADMIN']));
    app.post('/franchise',FranchiseController.create);app.get('/franchise',FranchiseController.getAll);app.get('/franchise/:id/photo',FranchiseController.getPhoto);app.get('/franchise/:id',FranchiseController.getOne);app.patch('/franchise/:id',FranchiseController.update);app.use(errorHandler);
    server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const endpoint='http://127.0.0.1:'+server.address().port;
    const request=(path:string,method='GET',body?:any,token=superToken)=>fetch(endpoint+path,{method,headers:{Authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    let sequence=0;const credentials=()=>({adminUser:{email:'photo-'+(++sequence)+'@example.invalid',password:'PhotoTestPass123!'}});
    const photo=(mimeType='image/png')=>({mimeType,dataBase64:images[mimeType],fileName:'../../untrusted.png'});
    const create=async(body:any)=>{const response=await request('/franchise','POST',body);const row:any=await response.json();assert.equal(response.status,201,JSON.stringify(row));return row;};
    let plain:any,saved:any;
    await t.test('email/password alone create branches without photos and preserve login',async()=>{
      const input=credentials();plain=await create(input);await create(credentials());assert.equal(plain.photo,null);assert.equal(plain.photoUrl,null);assert.equal(plain.name,'');assert.equal(plain.location,'');assert.equal(plain.contactNum,'');
      const login=await AuthService.login(input.adminUser.email,input.adminUser.password);assert.equal(login.user.role,'FRANCHISE_ADMIN');assert.equal(login.user.franchiseId,plain.id);
      const invalid=await request('/franchise','POST',{adminUser:{email:'invalid-email',password:'PhotoTestPass123!'}});assert.equal(invalid.status,400);
    });
    await t.test('valid JPG/PNG/WebP images persist against exact franchise IDs with safe metadata',async()=>{
      for(const mimeType of Object.keys(images)) {
        const row=await create({...credentials(),name:'Photo branch',photo:photo(mimeType)});saved=row;assert.ok(row.photo.id);assert.match(row.photoUrl,new RegExp('/franchise/'+row.id+'/photo'));
        assert.equal(row.photo.data,undefined);assert.equal(row.photo.dataBase64,undefined);assert.equal(row.dashboardPassword,undefined);assert.equal(row.aadhaarEncrypted,undefined);
        const stored=await prisma.franchise.findUniqueOrThrow({where:{id:row.id}});assert.equal((stored as any).photo,undefined);
        const response=await request('/franchise/'+row.id+'/photo');assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),mimeType);assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(images[mimeType],'base64'));
        const detail:any=await (await request('/franchise/'+row.id)).json();assert.equal(detail.photo.id,row.photo.id);
      }
      const rows:any=await (await request('/franchise')).json();assert.equal(rows.find((f:any)=>f.id===saved.id).photo.id,saved.photo.id);
    });
    await t.test('spoofed, unsupported, empty, oversized and cross-reference photo inputs are rejected',async()=>{
      const before=await prisma.franchise.count(),files=await prisma.attachment.count();
      for(const invalid of [{mimeType:'image/gif',dataBase64:Buffer.from('GIF89a').toString('base64')},{mimeType:'image/png',dataBase64:Buffer.from('<html>not an image</html>').toString('base64')},{mimeType:'image/jpeg',dataBase64:images['image/png']},{mimeType:'image/png',dataBase64:''},saved.photoUrl]) {
        const response=await request('/franchise','POST',{...credentials(),photo:invalid});assert.equal(response.status,422);
      }
      const huge=await request('/franchise','POST',{...credentials(),photo:{mimeType:'image/png',dataBase64:Buffer.alloc(MAX_FRANCHISE_PHOTO_BYTES+1).toString('base64')}});assert.equal(huge.status,413);
      assert.equal(await prisma.franchise.count(),before);assert.equal(await prisma.attachment.count(),files);
    });
    await t.test('editing without a photo field preserves it; replacement and removal are atomic',async()=>{
      const first=saved.photo.id;let response=await request('/franchise/'+saved.id,'PATCH',{name:'Updated branch'});let row:any=await response.json();assert.equal(response.status,200);assert.equal(row.photo.id,first);
      response=await request('/franchise/'+saved.id,'PATCH',{photo:photo('image/jpeg')});row=await response.json();assert.equal(response.status,200);assert.notEqual(row.photo.id,first);assert.equal(await prisma.attachment.count({where:{id:first}}),0);
      response=await request('/franchise/'+saved.id,'PATCH',{photo:null});row=await response.json();assert.equal(row.photo,null);assert.equal(row.photoUrl,null);assert.equal((await request('/franchise/'+saved.id+'/photo')).status,404);assert.equal((await prisma.franchise.findUniqueOrThrow({where:{id:saved.id}})).name,'Updated branch');
    });
    await t.test('franchise users can access only their own photos and cannot edit another franchise',async()=>{
      const user=await prisma.user.findFirstOrThrow({where:{franchiseId:plain.id}});const token=JwtUtil.generateAccessToken({userId:user.id,role:'FRANCHISE_ADMIN',franchiseId:plain.id});
      assert.equal((await request('/franchise/'+plain.id,'PATCH',{photo:photo()},token)).status,200);assert.equal((await request('/franchise/'+plain.id+'/photo','GET',undefined,token)).status,200);
      assert.equal((await request('/franchise/'+saved.id,'PATCH',{photo:photo()},token)).status,403);assert.equal((await request('/franchise/'+saved.id+'/photo','GET',undefined,token)).status,403);
      const unassigned=JwtUtil.generateAccessToken({userId:'unassigned',role:'FRANCHISE_ADMIN'});assert.equal((await request('/franchise/'+plain.id+'/photo','GET',undefined,unassigned)).status,403);assert.equal((await fetch(endpoint+'/franchise/'+plain.id+'/photo')).status,401);
    });
    await t.test('photo edits preserve Aadhaar, PAN, credentials and the response sanitizer',async()=>{
      const input={...credentials(),aadhaarNumber:'123456789012',panNumber:'ABCDE1234F',dashboardPassword:'PhotoTestPass123!'};const row=await create(input);const before=await prisma.franchise.findUniqueOrThrow({where:{id:row.id},omit:{aadhaarEncrypted:false}});const userBefore=await prisma.user.findFirstOrThrow({where:{franchiseId:row.id}});
      const updated:any=await (await request('/franchise/'+row.id,'PATCH',{photo:photo()})).json();assert.equal(updated.hasAadhaar,true);assert.equal(updated.aadhaarMasked,'XXXX XXXX 9012');assert.equal(updated.panNumber,'ABCDE1234F');assert.equal(updated.aadhaarEncrypted,undefined);assert.equal(updated.dashboardPassword,undefined);
      const after=await prisma.franchise.findUniqueOrThrow({where:{id:row.id},omit:{aadhaarEncrypted:false}});assert.equal(after.aadhaarEncrypted,before.aadhaarEncrypted);assert.equal(after.panNumber,before.panNumber);assert.equal(after.dashboardPassword,before.dashboardPassword);assert.equal((await prisma.user.findUniqueOrThrow({where:{id:userBefore.id}})).passwordHash,userBefore.passwordHash);
      assert.equal((await AuthService.login(input.adminUser.email,input.adminUser.password)).user.franchiseId,row.id);
    });
    await t.test('failed and concurrent creation leave no orphaned photo records',async()=>{
      const input={...credentials(),photo:photo()};const before=await prisma.franchise.count(),files=await prisma.attachment.count();
      const responses=await Promise.all([request('/franchise','POST',input),request('/franchise','POST',input)]);assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);assert.equal(await prisma.franchise.count(),before+1);assert.equal(await prisma.attachment.count(),files+1);
      const photos=await prisma.attachment.findMany({where:{entityType:FRANCHISE_PHOTO_ENTITY},select:{entityId:true}});for(const file of photos)assert.ok(await prisma.franchise.findUnique({where:{id:file.entityId}}));
    });
    await t.test('concurrent replacements retain one current photo',async()=>{
      const responses=await Promise.all([request('/franchise/'+saved.id,'PATCH',{photo:photo('image/png')}),request('/franchise/'+saved.id,'PATCH',{photo:photo('image/webp')})]);assert.ok(responses.every(r=>r.status===200));assert.equal(await prisma.attachment.count({where:{entityType:FRANCHISE_PHOTO_ENTITY,entityId:saved.id}}),1);
    });
  } finally {if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await prisma.$disconnect();}
});
