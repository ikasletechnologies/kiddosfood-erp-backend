import { randomUUID } from 'crypto';
import { FieldValidationError } from '../franchise/franchise.validation';

export const FRANCHISE_PHOTO_ENTITY = 'FRANCHISE_PHOTO';
export const MAX_FRANCHISE_PHOTO_BYTES = 5 * 1024 * 1024;
export type ValidatedPhoto = { data: Buffer; fileName: string; mimeType: string; size: number };
const invalid = (message:string,status=422):never => {throw new FieldValidationError({photo:message},status);};

/** Sniff the container and image headers; never trust a filename or MIME claim. */
export function imageMime(data:Buffer): string | null {
  if(data.length>=33 && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let offset=8,header=false,pixels=false,end=false;
    while(offset+12<=data.length) {
      const size=data.readUInt32BE(offset),type=data.toString('ascii',offset+4,offset+8);
      if(size>data.length-offset-12) return null;
      if(!header) {if(type!=='IHDR' || size!==13 || !data.readUInt32BE(offset+8) || !data.readUInt32BE(offset+12))return null;header=true;}
      if(type==='IDAT' && size>0)pixels=true;
      offset+=12+size;
      if(type==='IEND'){if(size!==0 || offset!==data.length)return null;end=true;break;}
    }
    return header && pixels && end ? 'image/png' : null;
  }
  if(data.length>10 && data[0]===255 && data[1]===216 && data[data.length-2]===255 && data[data.length-1]===217) {
    let offset=2,dimensions=false;
    while(offset<data.length-2) {
      if(data[offset++]!==255)return null;
      while(data[offset]===255)offset++;
      const marker=data[offset++];
      if(marker===0xda)return dimensions?'image/jpeg':null;
      if(marker===0xd8 || marker===0x01 || (marker>=0xd0 && marker<=0xd7))continue;
      if(offset+2>data.length)return null;
      const size=data.readUInt16BE(offset);
      if(size<2 || offset+size>data.length)return null;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if(size<8 || !data.readUInt16BE(offset+3) || !data.readUInt16BE(offset+5))return null;
        dimensions=true;
      }
      offset+=size;
    }
    return null;
  }
  if(data.length>=30 && data.toString('ascii',0,4)==='RIFF' && data.toString('ascii',8,12)==='WEBP' && data.readUInt32LE(4)===data.length-8) {
    let offset=12,dimensions=false,pixels=false;
    while(offset+8<=data.length) {
      const type=data.toString('ascii',offset,offset+4),size=data.readUInt32LE(offset+4),start=offset+8;
      if(size>data.length-start)return null;
      if(type==='VP8 '){if(size<10 || !data.subarray(start+3,start+6).equals(Buffer.from([157,1,42])) || !(data.readUInt16LE(start+6)&0x3fff) || !(data.readUInt16LE(start+8)&0x3fff))return null;dimensions=true;pixels=true;}
      if(type==='VP8L'){if(size<5 || data[start]!==47)return null;dimensions=true;pixels=true;}
      if(type==='VP8X'){if(size!==10)return null;dimensions=true;}
      if(type==='ANMF' && size>=16)pixels=true;
      offset=start+size+(size%2);
    }
    return offset===data.length && dimensions && pixels?'image/webp':null;
  }
  return null;
}

export function validateFranchisePhoto(input:any): ValidatedPhoto | null | undefined {
  if(input===undefined || input===null)return input;
  if(typeof input!=='object' || Array.isArray(input) || typeof input.dataBase64!=='string')return invalid('Choose a JPG, JPEG, PNG or WebP image.');
  const encoded=input.dataBase64.replace(/^data:image\/(?:jpeg|png|webp);base64,/,'');
  if(encoded.length>Math.ceil(MAX_FRANCHISE_PHOTO_BYTES/3)*4+4)return invalid('Franchise photo must be 5 MB or smaller.',413);
  if(!encoded || encoded.length%4!==0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))return invalid('The photo content is invalid. Choose the image again.');
  const data=Buffer.from(encoded,'base64');
  if(!data.length)return invalid('The photo is empty.');
  if(data.length>MAX_FRANCHISE_PHOTO_BYTES)return invalid('Franchise photo must be 5 MB or smaller.',413);
  const mimeType=imageMime(data),declared=String(input.mimeType || '').toLowerCase().replace('image/jpg','image/jpeg');
  if(!mimeType || (declared && declared!==mimeType))return invalid('Invalid image content. Only JPG, JPEG, PNG and WebP photos are supported.');
  const extension=mimeType==='image/jpeg'?'jpg':mimeType==='image/png'?'png':'webp';
  return {data,fileName:randomUUID()+'.'+extension,mimeType,size:data.length};
}
