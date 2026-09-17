import buildLibheif from './libheif-1.22.2.js';

const libheif=buildLibheif();

async function decodeBuffer(buffer){
  let decoder,images;
  try{
    decoder=new libheif.HeifDecoder();
    images=decoder.decode(buffer);
    if(!images.length)throw new Error('HEIF image not found');
    const image=images[0],width=image.get_width(),height=image.get_height();
    const imageData=new ImageData(width,height);
    for(let index=0;index<width*height;index++)imageData.data[index*4+3]=255;
    return await new Promise((resolve,reject)=>image.display(imageData,result=>result?resolve(result):reject(new Error('HEIF processing error'))));
  }finally{
    for(const image of images||[])image.free();
    if(decoder?.decoder)libheif.heif_context_free(decoder.decoder);
  }
}

self.onmessage=async event=>{
  const {id,buffer}=event.data||{};
  try{const imageData=await decodeBuffer(buffer);self.postMessage({id,imageData,error:''});}
  catch(error){self.postMessage({id,imageData:null,error:error?.message||String(error)});}
};
