import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import prisma from '../../lib/prisma';
import {JwtUtil} from '../../lib/jwt.util';
import {errorHandler} from '../../middleware/error.middleware';
import routes from '../../modules/franchise/franchise-document.routes';
import {AttachmentService} from '../../modules/attachments/attachment.service';
import {DOCUMENT_ENTITY,MAX_DOCUMENT_BYTES,validateDocument,documentJsonLimit} from '../../modules/franchise/franchise-document.validation';
import {FranchiseDocumentService} from '../../modules/franchise/franchise-document.service';

const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const payload=(category='CATALOGUE',extra:any={})=>({category,originalFileName:'catalogue.pdf',mimeType:'application/pdf',dataBase64:pdf.toString('base64'),...extra});
// Small standards-based Office containers for type validation (not scanner mocks).
function zip(entries:Record<string,string>){
  const chunks:Buffer[]=[],central:Buffer[]=[];let offset=0;
  const crc=(b:Buffer)=>{let value=0xffffffff;for(const byte of b){value^=byte;for(let k=0;k<8;k++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
  for(const [name,value] of Object.entries(entries)){const n=Buffer.from(name),v=Buffer.from(value),local=Buffer.alloc(30),entry=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc(v),14);local.writeUInt32LE(v.length,18);local.writeUInt32LE(v.length,22);local.writeUInt16LE(n.length,26);
    entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(crc(v),16);entry.writeUInt32LE(v.length,20);entry.writeUInt32LE(v.length,24);entry.writeUInt16LE(n.length,28);entry.writeUInt32LE(offset,42);
    chunks.push(local,n,v);central.push(entry,n);offset+=local.length+n.length+v.length;
  }const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,directory,end]);
}
function ole(stream:string){
  const data=Buffer.alloc(2048);Buffer.from('d0cf11e0a1b11ae1','hex').copy(data);data.writeUInt16LE(0xfffe,28);data.writeUInt16LE(9,30);data.writeUInt32LE(1,44);data.writeUInt32LE(1,48);data.writeUInt32LE(0,76);
  data.fill(255,512,1024);data.writeUInt32LE(0xfffffffd,512);data.writeUInt32LE(0xfffffffe,516);
  const name=Buffer.from(stream+'\0','utf16le');name.copy(data,1024);data.writeUInt16LE(name.length,1088);data[1090]=2;return data;
}
test('document validator verifies containers, unsafe content, limits and filenames',()=>{
  assert.equal(validateDocument(payload()).mimeType,'application/pdf');
  const word=zip({'[Content_Types].xml':'<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>','word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'});
  const sheet=zip({'[Content_Types].xml':'<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>','xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'});
  for(const [ext,bytes] of [['docx',word],['xlsx',sheet],['doc',ole('WordDocument')],['xls',ole('Workbook')]] as const)assert.equal(validateDocument(payload('CATALOGUE',{originalFileName:'document.'+ext,mimeType:'',dataBase64:bytes.toString('base64')})).extension,ext);
  for(const extra of [{originalFileName:'../private.pdf'},{originalFileName:'run.exe'},{dataBase64:Buffer.from('<script>fake</script>').toString('base64')},{dataBase64:Buffer.from('%PDF-1.4\n/JavaScript\n%%EOF').toString('base64')},{originalFileName:'test.xlsx',dataBase64:word.toString('base64'),mimeType:''},{dataBase64:''},{mimeType:'image/png'}])assert.throws(()=>validateDocument(payload('CATALOGUE',extra)));
  assert.throws(()=>validateDocument(payload('CATALOGUE',{dataBase64:Buffer.alloc(MAX_DOCUMENT_BYTES+1).toString('base64')})),(e:any)=>e.statusCode===413);
});
test('franchise document API lifecycle and isolation',{timeout:180000},async t=>{
  const target=new URL(process.env.DATABASE_URL || '');assert.equal(process.env.KIDDOS_DOCUMENT_TEST_DB,'1');assert.equal(target.hostname,'127.0.0.1');assert.equal(target.pathname,'/kiddos_documents_test');
  process.env.FIELD_ENCRYPTION_KEY=Buffer.alloc(32,42).toString('hex');let server:any;
  try {
    assert.equal(await prisma.franchise.count(),0,'Requires a fresh disposable database');
    const one=await prisma.franchise.create({data:{name:'Branch A',location:'A',ownerName:'Owner A',contactNum:''}});
    const two=await prisma.franchise.create({data:{name:'Branch B',location:'B',ownerName:'Owner B',contactNum:''}});
    const admin=await prisma.user.create({data:{fullName:'Super Admin',email:'documents@example.test',passwordHash:'test-only',role:'SUPER_ADMIN'}});
    const hq=JwtUtil.generateAccessToken({userId:admin.id,role:'SUPER_ADMIN'}),own=JwtUtil.generateAccessToken({userId:'branch-user',role:'FRANCHISE_ADMIN',franchiseId:one.id}),other=JwtUtil.generateAccessToken({userId:'other-user',role:'FRANCHISE_ADMIN',franchiseId:two.id});
    const app=express();app.use(express.json({limit:documentJsonLimit}));app.use('/api/franchise/:id/documents',routes);app.use(errorHandler);
    server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
    const request=(branch:string,path='',method='GET',body?:any,token:string|null=hq)=>fetch(origin+'/api/franchise/'+branch+'/documents'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    let doc:any,replacement:any;
    await t.test('nine optional categories, authentication and role enforcement',async()=>{
      const result:any=await (await request(one.id)).json();assert.equal(result.categories.length,9);assert.equal(result.documents.length,0);assert.equal(result.maxFileBytes,10*1024*1024);
      assert.equal((await request(one.id,'','GET',undefined,null)).status,401);
      assert.equal((await request(one.id,'','POST',payload(),own)).status,403);
      assert.equal((await request(one.id,'','GET',undefined,other)).status,403);
    });
    await t.test('upload persists encrypted private bytes and uploader metadata without altering photo or branch credentials',async()=>{
      const photo=await prisma.attachment.create({data:{entityType:'FRANCHISE_PHOTO',entityId:one.id,franchiseId:one.id,fileName:'photo.png',mimeType:'image/png',size:3,data:Buffer.from('old')}});
      const response=await request(one.id,'','POST',payload());assert.equal(response.status,200);doc=await response.json();
      assert.equal(doc.visibility,'INTERNAL');assert.equal(doc.uploadedBy,admin.id);assert.equal(doc.uploadedByName,'Super Admin');assert.equal(doc.version,1);assert.ok(doc.uploadedAt);assert.equal(doc.storageKey,undefined);
      const saved=await prisma.franchiseDocument.findUniqueOrThrow({where:{id:doc.id},include:{attachment:true}});
      assert.notDeepEqual(Buffer.from(saved.attachment.data),pdf);assert.match(Buffer.from(saved.attachment.data).toString('utf8'),/^v1:/);
      assert.ok(await prisma.attachment.findUnique({where:{id:photo.id}}));assert.equal((await prisma.user.findUniqueOrThrow({where:{id:admin.id}})).passwordHash,'test-only');
      assert.equal((await (await request(one.id)).json() as any).documents[0].id,doc.id);
    });
    await t.test('private documents cannot be listed or downloaded by franchises or through generic attachment APIs',async()=>{
      assert.equal((await (await request(one.id,'','GET',undefined,own)).json() as any).documents.length,0);
      assert.equal((await request(one.id,'/'+doc.id+'/file','GET',undefined,own)).status,404);
      const saved=await prisma.franchiseDocument.findUniqueOrThrow({where:{id:doc.id}});
      const user={userId:'branch-user',role:'FRANCHISE_ADMIN',franchiseId:one.id};
      await assert.rejects(AttachmentService.getFile(user,saved.storageKey));await assert.rejects(AttachmentService.remove(user,saved.storageKey));
      await assert.rejects(AttachmentService.getFile({userId:admin.id,role:'SUPER_ADMIN'},saved.storageKey));
    });
    await t.test('explicit sharing enables only owner access; preview/download use private safe response headers',async()=>{
      assert.equal((await request(one.id,'/'+doc.id,'PATCH',{visibility:'SHARED'})).status,200);
      const response=await request(one.id,'/'+doc.id+'/file?preview=true','GET',undefined,own);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);assert.match(response.headers.get('cache-control') || '',/no-store/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
      assert.equal((await (await request(one.id,'','GET',undefined,own)).json() as any).documents.length,1);
      assert.equal((await request(two.id,'/'+doc.id+'/file','GET',undefined,other)).status,404);
      assert.equal((await request(one.id,'/'+doc.id+'/file','GET',undefined,other)).status,403);
      assert.equal((await request(one.id,'?history=true','GET',undefined,own)).status,403);
      assert.equal((await request(one.id,'/'+doc.id,'PATCH',{visibility:'INTERNAL'},own)).status,403);
    });
    await t.test('replacement retains history, defaults private and revokes access to former shared versions',async()=>{
      assert.equal((await request(one.id,'','POST',payload())).status,409);
      const response=await request(one.id,'','POST',payload('CATALOGUE',{replaceId:doc.id,originalFileName:'new.pdf'}));assert.equal(response.status,200);replacement=await response.json();assert.equal(replacement.familyId,doc.familyId);assert.equal(replacement.version,2);assert.equal(replacement.visibility,'INTERNAL');
      const history:any=await (await request(one.id,'?history=true')).json();assert.equal(history.documents.length,2);assert.equal(history.documents.find((d:any)=>d.id===doc.id).status,'HISTORICAL');
      assert.equal((await request(one.id,'/'+doc.id+'/file','GET',undefined,own)).status,404);assert.equal((await request(one.id,'/'+doc.id+'/file')).status,200);
      assert.equal((await request(two.id,'','POST',payload('CATALOGUE',{replaceId:replacement.id}))).status,404);
    });
    await t.test('multiple legal/other documents and independent branch collections are supported',async()=>{
      for(const category of ['LEGAL_AGREEMENTS','OTHER_DOCUMENTS'])for(let i=0;i<2;i++)assert.equal((await request(one.id,'','POST',payload(category))).status,200);
      assert.equal((await request(two.id,'','POST',payload())).status,200);
      const a:any=await (await request(one.id)).json(),b:any=await (await request(two.id)).json();assert.equal(a.documents.length,5);assert.equal(b.documents.length,1);
    });
    await t.test('invalid files, oversize, forged replacement, invalid category and metadata leave no orphan bytes',async()=>{
      const before=await prisma.attachment.count({where:{entityType:DOCUMENT_ENTITY}});
      for(const invalid of [payload('BOGUS'),payload('BROCHURE',{originalFileName:'script.js'}),payload('BROCHURE',{dataBase64:'SGVsbG8='}),payload('BROCHURE',{replaceId:'missing'}),payload('BROCHURE',{visibility:'PUBLIC'}),payload('BROCHURE',{issueDate:'2026-02-31'})])assert.ok((await request(one.id,'','POST',invalid)).status>=400);
      assert.equal((await request(one.id,'','POST',payload('BROCHURE',{dataBase64:Buffer.alloc(MAX_DOCUMENT_BYTES+1).toString('base64')}))).status,413);
      assert.equal(await prisma.attachment.count({where:{entityType:DOCUMENT_ENTITY}}),before);
    });
    await t.test('concurrent single-category uploads produce one active file; archive retains content and audit contains no document contents',async()=>{
      const replies=await Promise.all([request(one.id,'','POST',payload('BROCHURE')),request(one.id,'','POST',payload('BROCHURE'))]);assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
      assert.equal((await request(one.id,'/'+replacement.id,'DELETE')).status,200);
      assert.equal((await prisma.franchiseDocument.findUniqueOrThrow({where:{id:replacement.id}})).status,'ARCHIVED');
      assert.equal((await request(one.id,'/'+replacement.id+'/file','GET',undefined,own)).status,404);
      assert.equal((await request(one.id,'/'+replacement.id+'/file')).status,200);
      const logs=await prisma.auditLog.findMany({where:{module:'FRANCHISE_DOCUMENTS'}});assert.ok(logs.some(l=>l.action==='DOWNLOAD'));assert.ok(logs.some(l=>l.action==='ARCHIVE'));assert.ok(!JSON.stringify(logs).includes('catalogue.pdf'));
    });
  }finally{if(server)await new Promise<void>(r=>server.close(()=>r()));await prisma.$disconnect();}
});

