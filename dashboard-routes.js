const express = require("express");

function installDashboardRoutes(app, axios) {
  app.get("/api/prospect-dashboard", async (req, res) => {
    const dashboardKey = String(req.query.key || "").trim();
    const trackingBase = String(process.env.SUPABASE_TRACKING_URL || "").replace(/\/$/, "");

    if (!dashboardKey || !trackingBase) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    try {
      const response = await axios.get(
        trackingBase + "/functions/v1/prospect-dashboard-data",
        {
          headers: { "x-dashboard-key": dashboardKey },
          timeout: 15000
        }
      );

      res.setHeader("Cache-Control", "no-store");
      return res.json(response.data);
    } catch (error) {
      const status = error.response?.status || 500;
      return res.status(status).json({
        success: false,
        error: status === 401 ? "Unauthorized" : "Unable to load dashboard data"
      });
    }
  });

  app.get("/dashboard", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(String.raw\`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Smart Stage PRO Prospect Engagement</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#090b0f;color:#f4f6f8;font-family:Inter,Arial,Helvetica,sans-serif}
.shell{max-width:1440px;margin:0 auto;padding:24px}
.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;margin-bottom:22px}
.brand{font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:#9aa4b2}
h1{margin:5px 0 0;font-size:32px}
.refresh{border:1px solid #343b46;background:#151922;color:#fff;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer}
.cards{display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));gap:12px;margin-bottom:20px}
.stat{background:#11151c;border:1px solid #222936;border-radius:14px;padding:16px}
.stat .n{font-size:28px;font-weight:800;margin-bottom:4px}
.stat .l{font-size:12px;color:#9aa4b2;text-transform:uppercase;letter-spacing:.08em}
.controls{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 14px}
select,input{background:#11151c;color:#fff;border:1px solid #303846;border-radius:9px;padding:10px 12px}
input{min-width:260px;flex:1}
.panel{background:#11151c;border:1px solid #222936;border-radius:14px;overflow:hidden;margin-bottom:20px}
.panel h2{font-size:16px;margin:0;padding:16px;border-bottom:1px solid #222936}
.tablewrap{overflow:auto}
table{width:100%;border-collapse:collapse;min-width:980px}
th,td{padding:12px 14px;text-align:left;border-bottom:1px solid #202733;font-size:13px}
th{color:#9aa4b2;font-size:11px;text-transform:uppercase;letter-spacing:.06em;position:sticky;top:0;background:#11151c}
tr:hover{background:#161c25}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:30px;padding:4px 8px;border-radius:999px;font-weight:800;background:#252d39}
.a{background:#173c2d}.b{background:#3c3217}.c{background:#2a2f38}
.progress{height:8px;background:#242b35;border-radius:999px;overflow:hidden;width:100px}
.progress i{display:block;height:100%;background:#e7edf5}
.link{color:#dfe7f3;text-decoration:underline;text-underline-offset:3px}
.eventgrid{display:grid;grid-template-columns:1.1fr 2fr 1fr 1fr;gap:0}
.eventgrid>div{padding:11px 14px;border-bottom:1px solid #202733;font-size:13px}
.muted{color:#9aa4b2}
.empty{padding:24px;color:#9aa4b2}
.error{display:none;background:#35191c;border:1px solid #6f2b32;color:#ffd9dc;padding:12px 14px;border-radius:10px;margin-bottom:16px}
@media(max-width:1000px){.cards{grid-template-columns:repeat(2,1fr)}.top{align-items:flex-start;flex-direction:column}.shell{padding:16px}.eventgrid{grid-template-columns:1fr 1fr}.eventgrid .addr{display:none}}
</style>
</head>
<body>
<div class="shell">
  <div class="top">
    <div><div class="brand">Smart Stage PRO</div><h1>Prospect Engagement</h1></div>
    <button id="refresh" class="refresh">Refresh</button>
  </div>

  <div id="error" class="error"></div>

  <div class="cards">
    <div class="stat"><div id="sTotal" class="n">—</div><div class="l">Total prospects</div></div>
    <div class="stat"><div id="sA" class="n">—</div><div class="l">Priority A</div></div>
    <div class="stat"><div id="sB" class="n">—</div><div class="l">Priority B</div></div>
    <div class="stat"><div id="sC" class="n">—</div><div class="l">Priority C</div></div>
    <div class="stat"><div id="sComplete" class="n">—</div><div class="l">Completed</div></div>
    <div class="stat"><div id="sQr" class="n">—</div><div class="l">QR clicked</div></div>
    <div class="stat"><div id="sPlans" class="n">—</div><div class="l">Plans clicked</div></div>
  </div>

  <div class="controls">
    <select id="priority">
      <option value="">All priorities</option>
      <option value="A">Priority A</option>
      <option value="B">Priority B</option>
      <option value="C">Priority C</option>
    </select>
    <select id="engagement">
      <option value="">All engagement</option>
      <option value="complete">Video complete</option>
      <option value="qr">QR clicked</option>
      <option value="plans">Plans clicked</option>
      <option value="50">Watched 50%+</option>
      <option value="0">No video start</option>
    </select>
    <input id="search" placeholder="Search agent, property or MLS">
  </div>

  <div class="panel">
    <h2>Who should I call next?</h2>
    <div class="tablewrap">
      <table>
        <thead><tr><th>Priority</th><th>Agent</th><th>Property</th><th>MLS</th><th>Watched</th><th>Score</th><th>QR</th><th>Plans</th><th>Last activity</th><th>Watch</th></tr></thead>
        <tbody id="prospects"></tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h2>Recent activity</h2>
    <div id="events"></div>
  </div>
</div>

<script>
const params = new URLSearchParams(location.search);
const key = params.get("key") || "";
let model = { prospects: [], recent_events: [], summary: {} };

function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));}
function when(v){
  if(!v) return "—";
  const d=new Date(v);
  return new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(d);
}
function priorityRank(v){return v==="A"?0:v==="B"?1:2;}

function renderSummary(){
  const s=model.summary||{};
  document.getElementById("sTotal").textContent=s.total??0;
  document.getElementById("sA").textContent=s.priority_a??0;
  document.getElementById("sB").textContent=s.priority_b??0;
  document.getElementById("sC").textContent=s.priority_c??0;
  document.getElementById("sComplete").textContent=s.completed??0;
  document.getElementById("sQr").textContent=s.qr_clicked??0;
  document.getElementById("sPlans").textContent=s.plans_clicked??0;
}

function filtered(){
  const p=document.getElementById("priority").value;
  const e=document.getElementById("engagement").value;
  const q=document.getElementById("search").value.trim().toLowerCase();
  return (model.prospects||[]).filter(x=>{
    if(p && x.follow_up_priority!==p) return false;
    if(e==="complete" && !x.video_completed) return false;
    if(e==="qr" && !x.qr_clicked) return false;
    if(e==="plans" && !x.plans_clicked) return false;
    if(e==="50" && Number(x.highest_video_percent||0)<50) return false;
    if(e==="0" && x.video_started) return false;
    if(q){
      const hay=[x.agent_name,x.property_address,x.mls_number].join(" ").toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  }).sort((a,b)=>{
    const pr=priorityRank(a.follow_up_priority)-priorityRank(b.follow_up_priority);
    if(pr) return pr;
    return new Date(b.last_engagement_at||0)-new Date(a.last_engagement_at||0);
  });
}

function renderProspects(){
  const rows=filtered();
  const el=document.getElementById("prospects");
  if(!rows.length){el.innerHTML='<tr><td colspan="10" class="empty">No prospects match these filters.</td></tr>';return;}
  el.innerHTML=rows.map(x=>{
    const pct=Number(x.highest_video_percent||0);
    return '<tr>'+
      '<td><span class="badge '+esc(String(x.follow_up_priority||"C").toLowerCase())+'">'+esc(x.follow_up_priority||"C")+'</span></td>'+
      '<td><strong>'+esc(x.agent_name||"—")+'</strong><br><span class="muted">'+esc(x.agent_email||"")+'</span></td>'+
      '<td>'+esc(x.property_address||"—")+'</td>'+
      '<td>'+esc(x.mls_number||"—")+'</td>'+
      '<td><div>'+pct+'%</div><div class="progress"><i style="width:'+Math.max(0,Math.min(100,pct))+'%"></i></div></td>'+
      '<td><strong>'+Number(x.engagement_score||0)+'</strong></td>'+
      '<td>'+(x.qr_clicked?"✓":"—")+'</td>'+
      '<td>'+(x.plans_clicked?"✓":"—")+'</td>'+
      '<td>'+esc(when(x.last_engagement_at))+'</td>'+
      '<td>'+(x.watch_url?'<a class="link" target="_blank" rel="noopener" href="'+esc(x.watch_url)+'">Open</a>':"—")+'</td>'+
      '</tr>';
  }).join("");
}

function renderEvents(){
  const el=document.getElementById("events");
  const items=(model.recent_events||[]).slice(0,30);
  if(!items.length){el.innerHTML='<div class="empty">No prospect activity yet.</div>';return;}
  el.innerHTML='<div class="eventgrid">'+items.map(e=>
    '<div><strong>'+esc(e.agent_name||e.prospect_id)+'</strong></div>'+
    '<div class="addr">'+esc(e.property_address||"")+'</div>'+
    '<div>'+esc(String(e.event_type||"").replaceAll("_"," "))+'</div>'+
    '<div class="muted">'+esc(when(e.created_at))+'</div>'
  ).join("")+'</div>';
}

async function load(){
  const error=document.getElementById("error");
  error.style.display="none";
  if(!key){error.textContent="Dashboard key is missing.";error.style.display="block";return;}
  try{
    const r=await fetch("/api/prospect-dashboard?key="+encodeURIComponent(key),{cache:"no-store"});
    const j=await r.json();
    if(!r.ok||!j.success) throw new Error(j.error||"Unable to load dashboard");
    model=j;
    renderSummary();
    renderProspects();
    renderEvents();
  }catch(e){
    error.textContent=e.message||"Unable to load dashboard";
    error.style.display="block";
  }
}

document.getElementById("refresh").addEventListener("click",load);
document.getElementById("priority").addEventListener("change",renderProspects);
document.getElementById("engagement").addEventListener("change",renderProspects);
document.getElementById("search").addEventListener("input",renderProspects);
load();
setInterval(load,60000);
</script>
</body>
</html>\`);
  });
}

module.exports = { installDashboardRoutes };
