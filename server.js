import express from "express";
import path from "node:path";
import {fileURLToPath} from "node:url";

const app=express();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({limit:"12mb"}));
app.use(express.static(path.join(__dirname,"public")));

app.get("/api/health",(req,res)=>res.json({
  ok:true,
  service:"DIMRI Model & Fan Studio",
  version:"0.2.0",
  imageProvider:process.env.OPENAI_API_KEY?"configured":"not_configured",
  videoProvider:"not_configured"
}));

app.post("/api/generate",async(req,res)=>{
  const {mode="free",modelId=null,prompt="",settings={}}=req.body||{};
  if(typeof prompt!=="string"||!prompt.trim())return res.status(400).json({ok:false,error:"Prompt is required"});
  const mediaMode=settings.mediaMode||"Create Image";
  if(mediaMode!=="Create Image")return res.status(501).json({ok:false,status:"provider_pending",message:"This creation mode needs a compatible video/editing provider. Image generation can be enabled with an OpenAI API key."});
  if(!process.env.OPENAI_API_KEY)return res.status(503).json({ok:false,status:"provider_not_configured",message:"Image provider is not configured yet. Add OPENAI_API_KEY in Render Environment to enable real image generation."});
  const identity=modelId?"Create an original fictional adult AI model identity named "+String(modelId)+". Maintain a coherent, realistic appearance within this image. ":"Create an original fictional adult AI model. ";
  const fullPrompt=identity+prompt.trim()+" Style: "+String(settings.style||"Photorealistic")+".";
  try{
    const response=await fetch("https://api.openai.com/v1/images/generations",{
      method:"POST",
      headers:{"Authorization":"Bearer "+process.env.OPENAI_API_KEY,"Content-Type":"application/json"},
      body:JSON.stringify({model:"gpt-image-1.5",prompt:fullPrompt,size:settings.aspectRatio==="9:16"?"1024x1536":settings.aspectRatio==="16:9"?"1536x1024":"1024x1024",quality:"medium"})
    });
    const payload=await response.json();
    if(!response.ok)return res.status(response.status>=500?502:400).json({ok:false,status:"provider_error",message:payload.error?.message||"Image provider request failed."});
    const image=payload.data?.[0]?.b64_json;
    if(!image)return res.status(502).json({ok:false,status:"provider_error",message:"Provider returned no image data."});
    res.json({ok:true,status:"completed",mode,modelId,imageDataUrl:"data:image/png;base64,"+image});
  }catch(error){
    res.status(502).json({ok:false,status:"provider_error",message:"Could not reach the image provider. Please try again."});
  }
});

app.use((req,res,next)=>{if(req.method!=="GET")return next();res.sendFile(path.join(__dirname,"public","index.html"))});
app.listen(process.env.PORT||10000,()=>console.log("DIMRI Model & Fan Studio online"));
