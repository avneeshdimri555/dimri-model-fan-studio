import express from "express";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {GoogleGenAI} from "@google/genai";
import crypto from "node:crypto";

const app=express();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({limit:"12mb"}));
app.use(express.static(path.join(__dirname,"public")));


const IG_API_VERSION=process.env.IG_API_VERSION||"v25.0";
const IG_GRAPH_BASE=`https://graph.instagram.com/${IG_API_VERSION}`;
const igConnections=new Map();
const oauthStates=new Map();
function requireIgConfig(){return process.env.IG_APP_ID&&process.env.IG_APP_SECRET&&process.env.IG_REDIRECT_URI}
function igAuthUrl(modelId){const state=crypto.randomBytes(24).toString("hex");oauthStates.set(state,{modelId,createdAt:Date.now()});const u=new URL("https://www.instagram.com/oauth/authorize");u.searchParams.set("client_id",process.env.IG_APP_ID);u.searchParams.set("redirect_uri",process.env.IG_REDIRECT_URI);u.searchParams.set("response_type","code");u.searchParams.set("scope",["instagram_business_basic","instagram_business_content_publish","instagram_business_manage_comments","instagram_business_manage_messages","instagram_business_manage_insights"].join(","));u.searchParams.set("state",state);return u.toString()}
async function igJson(url,options={}){const r=await fetch(url,options);const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data?.error?.message||data?.error_message||`Instagram API ${r.status}`);return data}
async function exchangeInstagramCode(code){const body=new URLSearchParams({client_id:process.env.IG_APP_ID,client_secret:process.env.IG_APP_SECRET,grant_type:"authorization_code",redirect_uri:process.env.IG_REDIRECT_URI,code});const short=await igJson("https://api.instagram.com/oauth/access_token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});const long=await igJson(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(process.env.IG_APP_SECRET)}&access_token=${encodeURIComponent(short.access_token)}`);const profile=await igJson(`${IG_GRAPH_BASE}/me?fields=id,username,account_type,followers_count,media_count,profile_picture_url&access_token=${encodeURIComponent(long.access_token)}`);return {accessToken:long.access_token,expiresIn:long.expires_in||0,profile}}
app.get("/api/instagram/config",(req,res)=>res.json({ok:true,configured:!!requireIgConfig(),apiVersion:IG_API_VERSION}));
app.get("/api/instagram/connect",(req,res)=>{const modelId=String(req.query.modelId||"");if(!modelId)return res.status(400).json({ok:false,error:"modelId is required"});if(!requireIgConfig())return res.status(503).json({ok:false,error:"Instagram Business Login is not configured on the server yet."});res.json({ok:true,url:igAuthUrl(modelId)})});
app.get("/api/instagram/callback",async(req,res)=>{const {code,state,error,error_description}=req.query;const pending=oauthStates.get(String(state||""));if(!pending||Date.now()-pending.createdAt>10*60*1000)return res.status(400).send("Instagram authorization state is invalid or expired. Return to DIMRI Model & Fan Studio and try again.");oauthStates.delete(String(state));if(error)return res.status(400).send(`Instagram authorization was not granted: ${error_description||error}`);try{const connection=await exchangeInstagramCode(String(code));igConnections.set(pending.modelId,{...connection,connectedAt:Date.now()});res.redirect(`/?instagram_connected=1&modelId=${encodeURIComponent(pending.modelId)}&username=${encodeURIComponent(connection.profile.username||"")}`)}catch(e){console.error("Instagram OAuth error:",e.message);res.status(502).send(`Instagram connection failed: ${e.message}`)}});
app.get("/api/instagram/:modelId/status",(req,res)=>{const c=igConnections.get(req.params.modelId);res.json({ok:true,connected:!!c,profile:c?.profile||null,expiresAt:c?new Date(Date.now()+Number(c.expiresIn||0)*1000).toISOString():null})});
app.post("/api/instagram/:modelId/refresh",async(req,res)=>{const c=igConnections.get(req.params.modelId);if(!c)return res.status(404).json({ok:false,error:"Instagram account is not connected"});try{const refreshed=await igJson(`${IG_GRAPH_BASE}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(c.accessToken)}`);c.accessToken=refreshed.access_token;c.expiresIn=refreshed.expires_in||0;res.json({ok:true,expiresIn:c.expiresIn})}catch(e){res.status(502).json({ok:false,error:e.message})}});
app.get("/api/instagram/:modelId/insights",async(req,res)=>{const c=igConnections.get(req.params.modelId);if(!c)return res.status(404).json({ok:false,error:"Instagram account is not connected"});try{const profile=await igJson(`${IG_GRAPH_BASE}/me?fields=id,username,account_type,followers_count,media_count,profile_picture_url&access_token=${encodeURIComponent(c.accessToken)}`);let insights=null;try{insights=await igJson(`${IG_GRAPH_BASE}/me/insights?metric=reach,profile_views,accounts_engaged,total_interactions&period=day&access_token=${encodeURIComponent(c.accessToken)}`)}catch(e){insights={error:e.message}}c.profile=profile;res.json({ok:true,profile,insights})}catch(e){res.status(502).json({ok:false,error:e.message})}});
app.get("/api/instagram/:modelId/media",async(req,res)=>{const c=igConnections.get(req.params.modelId);if(!c)return res.status(404).json({ok:false,error:"Instagram account is not connected"});try{const data=await igJson(`${IG_GRAPH_BASE}/me/media?fields=id,caption,media_type,timestamp,permalink,like_count,comments_count,media_url,thumbnail_url&limit=25&access_token=${encodeURIComponent(c.accessToken)}`);res.json({ok:true,...data})}catch(e){res.status(502).json({ok:false,error:e.message})}});
app.post("/api/instagram/:modelId/publish-image",async(req,res)=>{const c=igConnections.get(req.params.modelId);if(!c)return res.status(404).json({ok:false,error:"Instagram account is not connected"});const {imageUrl,caption=""}=req.body||{};if(!/^https:\/\//i.test(String(imageUrl||"")))return res.status(400).json({ok:false,error:"Instagram requires a publicly reachable HTTPS image URL for publishing."});try{const form=new URLSearchParams({image_url:String(imageUrl),caption:String(caption),access_token:c.accessToken});const created=await igJson(`${IG_GRAPH_BASE}/me/media`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:form.toString()});const published=await igJson(`${IG_GRAPH_BASE}/me/media_publish?creation_id=${encodeURIComponent(created.id)}&access_token=${encodeURIComponent(c.accessToken)}`,{method:"POST"});res.json({ok:true,container:created,published})}catch(e){res.status(502).json({ok:false,error:e.message})}});
app.post("/api/instagram/:modelId/comments/:commentId/reply",async(req,res)=>{const c=igConnections.get(req.params.modelId);if(!c)return res.status(404).json({ok:false,error:"Instagram account is not connected"});const message=String(req.body?.message||"").trim();if(!message)return res.status(400).json({ok:false,error:"Reply message is required"});try{const form=new URLSearchParams({message,access_token:c.accessToken});const data=await igJson(`${IG_GRAPH_BASE}/${encodeURIComponent(req.params.commentId)}/replies`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:form.toString()});res.json({ok:true,data})}catch(e){res.status(502).json({ok:false,error:e.message})}});
app.get("/api/instagram/:modelId/comments",async(req,res)=>{const c=igConnections.get(req.params.modelId);if(!c)return res.status(404).json({ok:false,error:"Instagram account is not connected"});try{const media=await igJson(`${IG_GRAPH_BASE}/me/media?fields=id&limit=25&access_token=${encodeURIComponent(c.accessToken)}`);const all=[];for(const item of media.data||[]){try{const comments=await igJson(`${IG_GRAPH_BASE}/${item.id}/comments?fields=id,text,timestamp,username&limit=50&access_token=${encodeURIComponent(c.accessToken)}`);all.push({mediaId:item.id,comments:comments.data||[]})}catch{}}res.json({ok:true,data:all})}catch(e){res.status(502).json({ok:false,error:e.message})}});
app.get("/webhooks/instagram",(req,res)=>{const verify=process.env.IG_VERIFY_TOKEN;if(req.query["hub.mode"]==="subscribe"&&req.query["hub.verify_token"]===verify)return res.status(200).send(req.query["hub.challenge"]);res.sendStatus(403)});
app.post("/webhooks/instagram",(req,res)=>{console.log("Instagram webhook event received",JSON.stringify(req.body));res.sendStatus(200)});

app.get("/api/health",(req,res)=>res.json({
  ok:true,
  service:"DIMRI Model & Fan Studio",
  version:"0.3.1",
  imageProvider:process.env.GEMINI_API_KEY?"gemini_configured":"not_configured",
  videoProvider:"not_configured"
}));

function imageFormat(aspectRatio){
  const allowed=["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"];
  return allowed.includes(aspectRatio)?aspectRatio:"9:16";
}

app.get("/api/providers",(_req,res)=>{
  res.json({
    ok:true,
    providers:[
      {id:"gemini",name:"Google Gemini",configured:Boolean(process.env.GEMINI_API_KEY),role:"primary"},
      {id:"pollinations",name:"Pollinations",configured:Boolean(process.env.POLLINATIONS_API_KEY),role:"fallback"}
    ]
  });
});

async function generateWithPollinations(fullPrompt,settings){
  if(!process.env.POLLINATIONS_API_KEY)throw new Error("Pollinations fallback is not configured.");
  const model=process.env.POLLINATIONS_IMAGE_MODEL||"black-forest-labs/flux.1-schnell";
  const params=new URLSearchParams({model});
  if(settings.aspectRatio==="9:16")params.set("width","768"),params.set("height","1365");
  else if(settings.aspectRatio==="4:5")params.set("width","1024"),params.set("height","1280");
  else if(settings.aspectRatio==="16:9")params.set("width","1365"),params.set("height","768");
  else params.set("width","1024"),params.set("height","1024");
  const url="https://gen.pollinations.ai/image/"+encodeURIComponent(fullPrompt)+"?"+params.toString();
  const response=await fetch(url,{headers:{Authorization:"Bearer "+process.env.POLLINATIONS_API_KEY}});
  if(!response.ok)throw new Error("Pollinations HTTP "+response.status);
  const mime=response.headers.get("content-type")||"image/jpeg";
  const buffer=Buffer.from(await response.arrayBuffer());
  if(!buffer.length)throw new Error("Pollinations returned an empty image.");
  return "data:"+mime+";base64,"+buffer.toString("base64");
}

app.post("/api/generate",async(req,res)=>{
  const {mode="free",modelId=null,prompt="",settings={},referenceImage=null,referenceConsent=false}=req.body||{};
  if(typeof prompt!=="string"||!prompt.trim())return res.status(400).json({ok:false,error:"Prompt is required"});
  const mediaMode=settings.mediaMode||"Create Image";
  if(mediaMode!=="Create Image")return res.status(501).json({
    ok:false,status:"provider_pending",
    message:"This mode is not connected yet. Create Image is the active face-model workflow."
  });
  if(referenceImage && referenceConsent!==true)return res.status(400).json({ok:false,error:"Confirm you have permission and consent to use this reference image."});
  let referencePart=null;
  if(referenceImage){
    if(typeof referenceImage!=="string"||referenceImage.length>10*1024*1024)return res.status(413).json({ok:false,error:"Reference image is too large. Use an image under 7 MB."});
    const match=referenceImage.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if(!match)return res.status(400).json({ok:false,error:"Use a PNG, JPEG or WebP reference image."});
    referencePart={type:"image",mime_type:match[1],data:match[2]};
  }

  const identity=modelId
    ? "Create an original fictional adult AI model identity named "+String(modelId)+". Keep the person's facial identity, age presentation, skin tone, eye colour, hair and proportions consistent with the supplied reference image when present. "
    : "Create an original fictional adult AI model. ";
  const fullPrompt=identity+prompt.trim()+" Style: "+String(settings.style||"Photorealistic")+". Do not depict a real public figure or impersonate a real person. If a reference image is provided, use it only as an authorized appearance reference and preserve the same adult person's recognizable facial identity; change only the requested scene, outfit, pose, camera and lighting.";

  const errors=[];
  if(process.env.GEMINI_API_KEY){
    try{
      const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
      const interaction=await ai.interactions.create({
        model:"gemini-3.1-flash-image",
        input:referencePart?[referencePart,{type:"text",text:fullPrompt}]:fullPrompt,
        response_format:{type:"image",mime_type:"image/png",aspect_ratio:imageFormat(settings.aspectRatio),image_size:"1K"}
      });
      let image=null;
      for(const step of interaction?.steps||[]){for(const block of step?.content||[]){if(block?.type==="image"&&block?.data){image=block.data;break}}if(image)break}
      if(!image&&interaction?.output_image?.data)image=interaction.output_image.data;
      if(image)return res.json({ok:true,status:"completed",provider:"gemini",mode,modelId,imageDataUrl:"data:image/png;base64,"+image});
      errors.push("Gemini returned no image");
    }catch(error){
      const message=error?.message||"Gemini image generation failed.";
      console.error("Gemini generation error:",message);
      errors.push("Gemini: "+message);
    }
  }else errors.push("Gemini key not configured");

  // Fallback is deliberately disabled for reference-image requests because a text-only fallback cannot guarantee identity preservation.
  if(!referencePart && process.env.POLLINATIONS_API_KEY){
    try{
      const imageDataUrl=await generateWithPollinations(fullPrompt,settings);
      return res.json({ok:true,status:"completed",provider:"pollinations",mode,modelId,imageDataUrl});
    }catch(error){
      const message=error?.message||"Pollinations generation failed.";
      console.error("Pollinations generation error:",message);
      errors.push("Pollinations: "+message);
    }
  }else if(referencePart && process.env.POLLINATIONS_API_KEY){
    errors.push("Pollinations fallback skipped for reference-image requests to protect face consistency");
  }else errors.push("Pollinations fallback key not configured");

  return res.status(503).json({
    ok:false,status:"provider_not_available",
    message:"No image provider completed this request. "+errors.join(" · ")
  });
});

app.use((req,res,next)=>{if(req.method!=="GET")return next();res.sendFile(path.join(__dirname,"public","index.html"))});
app.listen(process.env.PORT||10000,()=>console.log("DIMRI Model & Fan Studio online"));
