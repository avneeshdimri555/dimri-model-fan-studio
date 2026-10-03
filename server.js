import express from "express";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {GoogleGenAI} from "@google/genai";

const app=express();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({limit:"12mb"}));
app.use(express.static(path.join(__dirname,"public")));

app.get("/api/health",(req,res)=>res.json({
  ok:true,
  service:"DIMRI Model & Fan Studio",
  version:"0.3.0",
  imageProvider:process.env.GEMINI_API_KEY?"gemini_configured":"not_configured",
  videoProvider:"not_configured"
}));

function imageFormat(aspectRatio){
  const allowed=["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"];
  return allowed.includes(aspectRatio)?aspectRatio:"9:16";
}

app.post("/api/generate",async(req,res)=>{
  const {mode="free",modelId=null,prompt="",settings={}}=req.body||{};
  if(typeof prompt!=="string"||!prompt.trim())return res.status(400).json({ok:false,error:"Prompt is required"});
  const mediaMode=settings.mediaMode||"Create Image";
  if(mediaMode!=="Create Image")return res.status(501).json({
    ok:false,status:"provider_pending",
    message:"This mode is not connected yet. Real Gemini image generation is enabled for Create Image."
  });
  if(!process.env.GEMINI_API_KEY)return res.status(503).json({
    ok:false,status:"provider_not_configured",
    message:"Gemini image provider is not configured. Add GEMINI_API_KEY in Render Environment."
  });

  const identity=modelId
    ? "Create an original fictional adult AI model identity named "+String(modelId)+". Keep the person's appearance coherent within this generated image. "
    : "Create an original fictional adult AI model. ";
  const fullPrompt=identity+prompt.trim()+" Style: "+String(settings.style||"Photorealistic")+". Do not depict a real public figure or impersonate a real person.";

  try{
    const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
    const interaction=await ai.interactions.create({
      model:"gemini-2.5-flash-image",
      input:fullPrompt,
      response_format:{
        type:"image",
        mime_type:"image/png",
        aspect_ratio:imageFormat(settings.aspectRatio),
        image_size:"1K"
      }
    });
    const image=interaction?.output_image?.data;
    if(!image)return res.status(502).json({
      ok:false,status:"provider_error",
      message:"Gemini returned no image. Please try again."
    });
    res.json({
      ok:true,status:"completed",provider:"gemini",
      mode,modelId,
      imageDataUrl:"data:image/png;base64,"+image
    });
  }catch(error){
    const message=error?.message||"Gemini image generation failed.";
    console.error("Gemini generation error:",message);
    res.status(502).json({ok:false,status:"provider_error",message});
  }
});

app.use((req,res,next)=>{if(req.method!=="GET")return next();res.sendFile(path.join(__dirname,"public","index.html"))});
app.listen(process.env.PORT||10000,()=>console.log("DIMRI Model & Fan Studio online"));
