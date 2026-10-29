import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import app from '../../app';
import prisma from '../../lib/prisma';
import {JwtUtil} from '../../lib/jwt.util';
import {FranchiseDocumentService} from '../../modules/franchise/franchise-document.service';

// Exercise the real app mount, not a test-only Router mount. Services are
// stubbed so these requests never read or write ERP records.
test('running app registers authenticated document listing and uploads',async()=>{
  const list=mock.method(FranchiseDocumentService,'list',async()=>({categories:[],maxFileBytes:10485760,documents:[]}));
  const upload=mock.method(FranchiseDocumentService,'upload',async()=>({id:'test-document',franchiseId:'test-branch',visibility:'INTERNAL'} as any));
  const server=app.listen(0,'127.0.0.1');
  try{
    await new Promise<void>(resolve=>server.once('listening',resolve));
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const url='http://127.0.0.1:'+address.port+'/api/franchise/test-branch/documents';
    const token=JwtUtil.generateAccessToken({userId:'route-test',role:'SUPER_ADMIN'});
    const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
    const response=await fetch(url,{headers});assert.equal(response.status,200);assert.deepEqual((await response.json() as any).documents,[]);
    assert.equal(list.mock.calls[0].arguments[1],'test-branch');
    const body={category:'CATALOGUE',originalFileName:'test.pdf',mimeType:'application/pdf',dataBase64:Buffer.from('%PDF-1.4\n%%EOF').toString('base64')};
    const posted=await fetch(url,{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal(posted.status,200);assert.equal((await posted.json() as any).id,'test-document');
    assert.equal(upload.mock.calls[0].arguments[1],'test-branch');
    assert.equal(upload.mock.calls[0].arguments[2].category,'CATALOGUE');
    const anonymous=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(anonymous.status,401);await anonymous.text();assert.equal(upload.mock.callCount(),1);
  }finally{list.mock.restore();upload.mock.restore();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await prisma.$disconnect();}
});

