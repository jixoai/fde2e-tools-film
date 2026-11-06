/** Stored ZIP streamed to OPFS. Only one image and the small central directory stay in memory. */
import { crc32 } from './interchange.ts';

export async function exportZip(signal: AbortSignal) {
  const root=await navigator.storage.getDirectory();
  const cache=await root.getDirectoryHandle('fde2e-render-cache',{create:true});
  const name=`${crypto.randomUUID()}.zip`,file=await cache.getFileHandle(name,{create:true});
  const writer=await file.createWritable();const central:Uint8Array[]=[];let offset=0,closed=false;
  const write=async(data:Blob|Uint8Array)=>{signal.throwIfAborted();await writer.write(data as FileSystemWriteChunkType);offset+=data instanceof Blob?data.size:data.byteLength;};
  const cleanup=async()=>{if(!closed){closed=true;await writer.abort().catch(()=>{});}await cache.removeEntry(name).catch(()=>{});};
  return {
    async add(path:string,blob:Blob){
      signal.throwIfAborted();if(closed)throw new Error('ZIP is closed');
      const encoded=new TextEncoder().encode(path);
      if(!encoded.length||encoded.length>65535||central.length>=65534||blob.size>=0xffffffff||offset+blob.size+encoded.length+128>=0xffffffff)throw new Error('ZIP export exceeds the 4 GiB / 65534 frame limit');
      let crc=0;const reader=blob.stream().getReader();
      try{for(;;){signal.throwIfAborted();const part=await reader.read();if(part.done)break;crc=crc32(part.value,crc);}}finally{reader.releaseLock();}
      const start=offset,header=new Uint8Array(30+encoded.length),h=new DataView(header.buffer);
      h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x0800,true);h.setUint16(12,33,true);
      h.setUint32(14,crc,true);h.setUint32(18,blob.size,true);h.setUint32(22,blob.size,true);h.setUint16(26,encoded.length,true);header.set(encoded,30);
      await write(header);await write(blob);
      const entry=new Uint8Array(46+encoded.length),c=new DataView(entry.buffer);
      c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x0800,true);c.setUint16(14,33,true);
      c.setUint32(16,crc,true);c.setUint32(20,blob.size,true);c.setUint32(24,blob.size,true);c.setUint16(28,encoded.length,true);c.setUint32(42,start,true);entry.set(encoded,46);central.push(entry);
    },
    async finish():Promise<File>{
      const start=offset;for(const entry of central)await write(entry);const end=new Uint8Array(22),e=new DataView(end.buffer);
      e.setUint32(0,0x06054b50,true);e.setUint16(8,central.length,true);e.setUint16(10,central.length,true);e.setUint32(12,offset-start,true);e.setUint32(16,start,true);
      await write(end);await writer.close();closed=true;return file.getFile();
    },
    cleanup,
  };
}
