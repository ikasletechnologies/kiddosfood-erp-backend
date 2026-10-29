import { inflateRawSync } from 'zlib';
import { AppError } from '../../middleware/error.middleware';
import { imageMime } from '../attachments/franchise-photo';

export const DOCUMENT_CATEGORIES = [
  {id:'CATALOGUE',name:'Catalogue'}, {id:'BROCHURE',name:'Brochure'},
  {id:'RENTAL_AGREEMENT',name:'Rental Agreement'}, {id:'FSSAI_CERTIFICATE',name:'FSSAI Certificate'},
  {id:'LEGAL_AGREEMENTS',name:'Legal Agreements',multiple:true},
  {id:'OTHER_DOCUMENTS',name:'Other Documents (Aadhaar, PAN, etc.)',multiple:true},
  {id:'APPLICATION_FORM',name:'Application Form'}, {id:'FRANCHISE_PRICE_LIST',name:'Franchise Price List'},
  {id:'CUSTOMER_PRICE_LIST',name:'Customer Price List'},
] as const;
const configured = Number(process.env.FRANCHISE_DOCUMENT_MAX_MB || 10);
export const MAX_DOCUMENT_BYTES = Math.round((Number.isFinite(configured) && configured >= 1 && configured <= 25 ? configured : 10)*1024*1024);
export const DOCUMENT_ENTITY = 'FRANCHISE_DOCUMENT';
export const documentJsonLimit = Math.ceil(MAX_DOCUMENT_BYTES*4/3)+1024*1024;
const bad = (text:string,status=422):never => { throw new AppError(text,status); };
export const mimeByExtension:Record<string,string> = {
  pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',
};

function officeZip(data:Buffer,extension:string):boolean {
  let end=-1;
  for(let i=data.length-22;i>=Math.max(0,data.length-65557);i--)if(data.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0 || data.readUInt16LE(end+4)!==0 || data.readUInt16LE(end+6)!==0 || end+22+data.readUInt16LE(end+20)!==data.length)return false;
  const count=data.readUInt16LE(end+10);let at=data.readUInt32LE(end+16),expanded=0;
  if(!count || count>2048)return false;
  const needed=new Map<string,string>(); const names=new Set<string>();
  for(let i=0;i<count;i++){
    if(at+46>data.length || data.readUInt32LE(at)!==0x02014b50)return false;
    const flags=data.readUInt16LE(at+8),method=data.readUInt16LE(at+10),size=data.readUInt32LE(at+20),output=data.readUInt32LE(at+24);
    const nameLength=data.readUInt16LE(at+28),extra=data.readUInt16LE(at+30),comment=data.readUInt16LE(at+32),local=data.readUInt32LE(at+42);
    if(at+46+nameLength+extra+comment>end || flags&1 || ![0,8].includes(method))return false;
    const name=data.toString('utf8',at+46,at+46+nameLength);
    if(names.has(name) || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || /vbaProject|activex|embeddings|\.(exe|dll|js|vbs|bat|cmd|ps1)$/i.test(name))return false;
    names.add(name);expanded+=output;if(expanded>50*1024*1024)return false;
    if(local+30>data.length || data.readUInt32LE(local)!==0x04034b50)return false;
    const start=local+30+data.readUInt16LE(local+26)+data.readUInt16LE(local+28);
    if(start+size>data.length)return false;
    if(['[Content_Types].xml','word/document.xml','xl/workbook.xml'].includes(name)){
      try {const bytes=method===0?data.subarray(start,start+size):inflateRawSync(data.subarray(start,start+size),{maxOutputLength:8*1024*1024});
        if(bytes.length!==output || /<!DOCTYPE|<!ENTITY/i.test(bytes.toString('utf8')))return false;
        needed.set(name,bytes.toString('utf8'));
      }catch{return false;}
    }
    at+=46+nameLength+extra+comment;
  }
  const types=needed.get('[Content_Types].xml') || '';
  return extension==='docx'
    ? /wordprocessingml.document.main\+xml/.test(types) && /<(?:\w+:)?document\b/.test(needed.get('word/document.xml') || '')
    : /spreadsheetml.sheet.main\+xml/.test(types) && /<(?:\w+:)?workbook\b/.test(needed.get('xl/workbook.xml') || '');
}
function legacyOffice(data:Buffer,extension:string):boolean {
  if(data.length<512 || data.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1' || data.readUInt16LE(28)!==0xfffe)return false;
  const shift=data.readUInt16LE(30);if(shift!==9 && shift!==12)return false;
  const sectorSize=2**shift, fatCount=data.readUInt32LE(44);if(fatCount<1 || fatCount>109)return false;
  const fat:number[]=[];
  for(let i=0;i<fatCount;i++){const sector=data.readUInt32LE(76+i*4),start=(sector+1)*sectorSize;
    if(start+sectorSize>data.length)return false;
    for(let j=0;j<sectorSize;j+=4)fat.push(data.readUInt32LE(start+j));
  }
  let sector=data.readUInt32LE(48);const seen=new Set<number>(),names:string[]=[];
  while(sector!==0xfffffffe){
    if(seen.has(sector) || seen.size>2048)return false;seen.add(sector);
    const start=(sector+1)*sectorSize;if(start+sectorSize>data.length)return false;
    for(let j=0;j<sectorSize;j+=128){const len=data.readUInt16LE(start+j+64),type=data[start+j+66];
      if((type===1 || type===2) && len>=2 && len<=64)names.push(data.toString('utf16le',start+j,start+j+len-2));
    }
    sector=fat[sector];if(sector===undefined)return false;
  }
  if(names.some(n=>/VBA|Macros/i.test(n)))return false;
  return extension==='doc'?names.includes('WordDocument'):names.some(n=>n==='Workbook'||n==='Book');
}
export function validateDocument(body:any) {
  const fileName=String(body.originalFileName || '');
  if(!fileName || fileName.length>180 || /[\x00-\x1f\x7f/\\]/.test(fileName))return bad('Choose a valid file name without path components.');
  const extension=fileName.split('.').pop()?.toLowerCase() || '',mimeType=mimeByExtension[extension];
  if(!mimeType)return bad('Supported files: PDF, DOC, DOCX, JPG, JPEG, PNG, WebP, XLS and XLSX.');
  const encoded=body.dataBase64;
  if(typeof encoded!=='string' || !encoded || encoded.length%4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))return bad('Invalid file content.');
  if(encoded.length>Math.ceil(MAX_DOCUMENT_BYTES/3)*4)return bad('File exceeds the configured size limit.',413);
  const data=Buffer.from(encoded,'base64');
  if(!data.length || data.length>MAX_DOCUMENT_BYTES)return bad('File exceeds the configured size limit or is empty.',413);
  let valid=false;
  if(mimeType.startsWith('image/'))valid=imageMime(data)===mimeType;
  else if(extension==='pdf'){
    const text=data.toString('latin1');
    // A destination array only sets the initial page/zoom. Executable action
    // dictionaries and encrypted PDFs are not accepted for inline preview.
    const safeOpenActions=[...text.matchAll(/\/OpenAction\b\s*(\S)/g)].every(match=>match[1]==='[');
    valid=/^%PDF-(?:1\.[0-9]|2\.0)/.test(text) && /%%EOF\s*$/.test(text) && safeOpenActions && !/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|AA|Encrypt)\b/.test(text);
  }else if(extension==='docx'||extension==='xlsx')valid=officeZip(data,extension);
  else valid=legacyOffice(data,extension);
  if(!valid || (body.mimeType && body.mimeType!==mimeType && body.mimeType!=='application/octet-stream'))return bad('File content does not match a supported document type. Encrypted or active-content documents are not accepted.');
  return {data,fileName,mimeType,size:data.length,extension};
}

