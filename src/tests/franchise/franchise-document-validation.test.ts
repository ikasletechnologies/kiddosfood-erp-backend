import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateDocument} from '../../modules/franchise/franchise-document.validation';
const file=(text:string)=>({originalFileName:'exported.pdf',mimeType:'application/pdf',dataBase64:Buffer.from(text).toString('base64')});
test('normal PDF initial-view destinations and PDF 2.0 exports can be uploaded',()=>{
  for(const header of ['%PDF-1.4','%PDF-2.0'])assert.equal(validateDocument(file(header+'\n/OpenAction [3 0 R /FitH null]\n%%EOF\n')).mimeType,'application/pdf');
});
test('PDF executable actions, encrypted files and disguised HTML remain rejected',()=>{
  for(const body of ['/OpenAction << /S /JavaScript /JS (alert) >>','/OpenAction 5 0 R','/OpenAction [3 0 R] /JavaScript (alert)','/Encrypt 10 0 R'])assert.throws(()=>validateDocument(file('%PDF-1.4\n'+body+'\n%%EOF')));
  assert.throws(()=>validateDocument(file('<html>not a PDF</html>')));
});

