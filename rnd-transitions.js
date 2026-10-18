"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const {execFile} = require("child_process");
const {promisify} = require("util");
const {S3Client,PutObjectCommand} = require("@aws-sdk/client-s3");
const execFileAsync=promisify(execFile);
const PRESETS=["liquid_wormhole","liquid_wormhole_impact"];
const REGION=process.env.AWS_REGION||"us-east-2";
const BUCKET=process.env.AWS_S3_BUCKET;
const s3=new S3Client({region:REGION});
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
function validate(body){
 const preset=body.preset||"liquid_wormhole";
 if(!PRESETS.includes(preset))throw Error("Invalid preset");
 for(const name of ["image_a_url","image_b_url"]){
  try{const u=new URL(body[name]);if(u.protocol!=="https:")throw Error();}catch{throw Error(name+" must be a public HTTPS image URL");}
 }
 const duration=Number(body.duration??0.9);
 if(!Number.isFinite(duration)||duration<0.5||duration>1.5)throw Error("duration must be 0.5–1.5 seconds");
 const fps=Number(body.fps??30);if(![24,30].includes(fps))throw Error("fps must be 24 or 30");
 const aspect=body.aspect_ratio||"9:16";if(!["9:16","16:9"].includes(aspect))throw Error("aspect_ratio must be 9:16 or 16:9");
 const strength=Number(body.intensity??0.65);if(!Number.isFinite(strength)||strength<0||strength>1)throw Error("intensity must be 0–1");
 const shake=Number(body.shake_px??18);if(!Number.isFinite(shake)||shake<0||shake>35)throw Error("shake_px must be 0–35");
 const originX=Number(body.origin_x??0.5),originY=Number(body.origin_y??0.5);
 if(![originX,originY].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error("origin coordinates must be 0–1");
 return {preset,duration,fps,aspect,strength,shake,originX,originY};
}
async function getImage(url,dest){
 const r=await axios.get(url,{responseType:"arraybuffer",timeout:30000,maxContentLength:20*1024*1024});
 if(!String(r.headers["content-type"]||"").startsWith("image/"))throw Error("Input URL did not return an image");
 await fs.promises.writeFile(dest,r.data);
}
function filters(p){
 const w=p.aspect==="9:16"?1080:1920,h=p.aspect==="9:16"?1920:1080;
 const d=p.duration.toFixed(3),offset="1.000",total=(2+p.duration).toFixed(3);
 const zoom=(1.045+0.035*p.strength).toFixed(4);
 const rotation=(0.12*p.strength).toFixed(4);
 const cx=(p.originX*w).toFixed(1),cy=(p.originY*h).toFixed(1);
 // FFmpeg rotate uses radians, and runs on each incoming frame. Opposing twists create the vortex sensation.
 const a1="'"+rotation+"*min(max((t-0.8)/"+d+",0),1)'";
 const a2="'-"+rotation+"*(1-min(max(t/"+d+",0),1))'";
 const pad=180,ww=w+2*pad,hh=h+2*pad;
 const prefix=(i,label,angle)=>[
  "["+i+":v]fps="+p.fps,
  "scale="+ww+":"+hh+":force_original_aspect_ratio=increase",
  "crop="+ww+":"+hh,
  "setsar=1",
  "rotate="+angle+":c=black:ow=iw:oh=ih",
  "crop="+w+":"+h+":"+pad+":"+pad,
  "format=yuv420p["+label+"]"
 ].join(",");
 const shake=p.preset==="liquid_wormhole_impact"?p.shake:0;
 // Animate a fast-damped jolt centered on the image swap. Crop overscan prevents exposed edges.
 const amp=shake.toFixed(2),start=(1+p.duration*0.42).toFixed(3);
 const nx="'"+pad+"+"+amp+"*exp(-18*max(t-"+start+",0))*sin(110*max(t-"+start+",0))*gte(t,"+start+")'";
 const ny="'"+pad+"+"+amp+"*0.60*exp(-18*max(t-"+start+",0))*cos(94*max(t-"+start+",0))*gte(t,"+start+")'";
 // circleopen expands the second image out from the first. Rotation and blur simulate refractive pull.
 const graph=[
 prefix(0,"a",a1),
 prefix(1,"b",a2),
 "[a][b]xfade=transition=circleopen:duration="+d+":offset="+offset+",",
 "pad="+ww+":"+hh+":"+pad+":"+pad+":color=black,",
 "crop="+w+":"+h+":x="+nx+":y="+ny+",",
 "format=yuv420p[outv]"
 ].join("");
 return {graph,w,h,total,origin:{x:cx,y:cy}};
}
function safe(v){return String(v||"transition").toLowerCase().replace(/[^a-z0-9-_]/g,"-").slice(0,80);}
module.exports=function registerTransitionRoutes(app){
 app.get("/rnd-transition-presets",(_req,res)=>res.json({success:true,presets:PRESETS,version:"0.1.0",status:"prototype"}));
 app.post("/test-transition",async(req,res)=>{
  let p;try{p=validate(req.body||{});}catch(e){return res.status(400).json({success:false,error:e.message});}
  if(!BUCKET)return res.status(503).json({success:false,error:"AWS_S3_BUCKET is not configured"});
  const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),"ssp-transition-"));
  try{
   const a=path.join(dir,"a.jpg"),b=path.join(dir,"b.jpg"),out=path.join(dir,"transition.mp4");
   await Promise.all([getImage(req.body.image_a_url,a),getImage(req.body.image_b_url,b)]);
   const f=filters(p);
   const firstSeconds=(1+p.duration).toFixed(3),secondSeconds=(2+p.duration).toFixed(3);
   const args=["-y","-loop","1","-framerate",String(p.fps),"-t",firstSeconds,"-i",a,
    "-loop","1","-framerate",String(p.fps),"-t",secondSeconds,"-i",b,
    "-filter_complex",f.graph,"-map","[outv]","-t",f.total,
    "-an","-c:v","libx264","-preset","veryfast","-crf","20",
    "-pix_fmt","yuv420p","-movflags","+faststart",out];
   await execFileAsync("ffmpeg",args,{maxBuffer:10*1024*1024,timeout:180000});
   const key="ssp-prospects/"+safe(req.body.prospect_id||"transition-rnd")+"/tests/"+safe(req.body.output_name||p.preset)+"-"+Date.now()+".mp4";
   await s3.send(new PutObjectCommand({Bucket:BUCKET,Key:key,Body:fs.createReadStream(out),ContentType:"video/mp4"}));
   const url="https://"+BUCKET+".s3."+REGION+".amazonaws.com/"+key.split("/").map(encodeURIComponent).join("/");
   res.json({success:true,video_url:url,public_id:key,render:{preset:p.preset,duration:p.duration,aspect_ratio:p.aspect,render_width:f.w,render_height:f.h,fps:p.fps,intensity:p.strength,shake_px:p.preset==="liquid_wormhole_impact"?p.shake:0,status:"optical wormhole prototype; not true fluid displacement"}});
  }catch(e){console.error("[TRANSITION RND]",e.stderr||e.message);res.status(500).json({success:false,error:e.message});}
  finally{await fs.promises.rm(dir,{recursive:true,force:true});}
 });
};