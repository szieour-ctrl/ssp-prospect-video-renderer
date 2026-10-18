"use strict";
// Exact filters(p) implementation recovered from fbc96753a9246fe5dd007fea490d5084822a011d.
module.exports = function filters(p){
 const w=p.aspect==="9:16"?1080:1920,h=p.aspect==="9:16"?1920:1080;
 const d=p.duration.toFixed(3),offset="1.000",total=(2+p.duration).toFixed(3);
 const zoom=(1.045+0.035*p.strength).toFixed(4);
 const rotation=(0.045*p.strength).toFixed(4);
 const cx=(p.originX*w).toFixed(1),cy=(p.originY*h).toFixed(1);
 // FFmpeg rotate uses radians, and runs on each incoming frame. Opposing twists create the vortex sensation.
 const a1="'"+rotation+"*exp(-20*max(t-1.40,0))*sin(75*max(t-1.40,0))*gte(t,1.40)'";
 const a2="'-"+rotation+"*exp(-20*max(t-0.40,0))*sin(75*max(t-0.40,0))*gte(t,0.40)'";
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
 prefix(0,"a",a1)+";",
 prefix(1,"b",a2)+";",
 "[a][b]xfade=transition=circleopen:duration="+d+":offset="+offset+",",
 "pad="+ww+":"+hh+":"+pad+":"+pad+":color=black,",
 "crop="+w+":"+h+":x="+nx+":y="+ny+",",
 "eq=brightness=\'-0.17*exp(-pow((t-"+(1+p.duration*0.5).toFixed(3)+")/"+(p.duration*0.25).toFixed(3)+",2))\':eval=frame,format=yuv420p[outv]"
 ].join("");
 return {graph,w,h,total,origin:{x:cx,y:cy}};
};
